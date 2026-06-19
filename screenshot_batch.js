const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * ============================================================
 * screenshot_batch.js（安定化リファクタ版）
 * ------------------------------------------------------------
 * 目的:
 *   - TOPページのアニメーション/リビール後の状態を安定して撮る
 *   - 白紙・空ヒーローの「成功扱い」を品質判定で検出する
 *   - 静止画で破綻するサイトを動画候補(needsVideo)へ自動仕分け
 *
 * 既存互換:
 *   - screenshots_db/{domain}.json の構造（meta/assets/analysis/tags/_site）を維持
 *   - 画像保存先・webp/quality:80/fullPage を維持
 *   - index.json / gallery 読み込みを壊さない（追加フィールドのみ）
 *
 * 実行:
 *   node screenshot_batch.js ./sitemaps/mmslaw_jp.json
 *   RECAPTURE=1     全URLを再撮影
 *   RECAPTURE=fail  既存品質が fail / 未評価のものだけ再撮影
 * ============================================================
 */

// ---------------------------------------
// 設定（チューニング可能）
// ---------------------------------------
const TOP_INITIAL_WAIT = 3000;
const SCROLL_STEP = 300;
const SCROLL_INTERVAL = 120;
const LAZYLOAD_MAX_TIME = 8000;
const IMAGE_WAIT_TIMEOUT = 5000;
const FONTS_WAIT_TIMEOUT = 5000;
const HERO_PAINT_TIMEOUT = 6000;
const PAGE_LOAD_TIMEOUT = 30000;
const PAGE_LOAD_FALLBACK_TIMEOUT = 15000;

const MAX_CAPTURE_ATTEMPTS = 2; // 初回 + リトライ1回（品質failのとき）

// 品質判定しきい値（ヒューリスティック）
const HERO_BLANK_FAIL = 0.9; // 先頭ビューの空白率がこれ以上で fail
const HERO_BLANK_WARN = 0.72; // 同 warn
const BPP_FAIL = 0.012; // bytes/pixel がこれ未満は「ほぼ白紙」疑い(fail)
const BPP_WARN = 0.02; // 縦長かつ低密度なら warn
const TALL_RATIO = 6; // height/width がこれ以上で「縦長」とみなす

const RECAPTURE = process.env.RECAPTURE || ""; // "", "1"/"all", "fail"

const SITEMAP_FILE = process.argv[2];
if (!SITEMAP_FILE) {
	console.error("❌ sitemap.json を指定してください");
	console.error("   例: node screenshot_batch.js ./sitemaps/mmslaw_jp.json");
	process.exit(1);
}

const urls = JSON.parse(fs.readFileSync(SITEMAP_FILE, "utf-8"));
if (!Array.isArray(urls) || urls.length === 0) {
	console.error("❌ sitemap.json は1件以上の URL 配列である必要があります");
	process.exit(1);
}

const firstURL = new URL(urls[0]);
const domain = firstURL.hostname.replace(/\./g, "_");
const DB_FILE = `./screenshots_db/${domain}.json`;
const LOG_DIR = "./logs";

fs.mkdirSync("./screenshots_db", { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let db = {};
if (fs.existsSync(DB_FILE)) {
	db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

const VIEWPORTS = {
	pc: {
		width: 1280,
		height: 900,
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
	},
	sp: {
		width: 390,
		height: 844,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile Safari/604.1"
	}
};

// ---------------------------------------
// 汎用ユーティリティ
// ---------------------------------------
function toSafeSlug(url) {
	const urlObj = new URL(url);
	const paths = urlObj.pathname.split("/").filter(Boolean);
	return paths.length === 0 ? "top" : paths.join("_");
}

function wait(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isTopPage({ slug, pathname, depth }) {
	return slug === "top" || pathname === "/" || depth === 0;
}

// ---------------------------------------
// webp サイズ読み取り（ネイティブ依存なし）
// ---------------------------------------
function readWebpDimensions(buffer) {
	try {
		if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF") {
			return null;
		}
		const format = buffer.toString("ascii", 12, 16);
		if (format === "VP8X") {
			const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
			const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
			return { width, height };
		}
		if (format === "VP8 ") {
			const width = (buffer[26] | (buffer[27] << 8)) & 0x3fff;
			const height = (buffer[28] | (buffer[29] << 8)) & 0x3fff;
			return { width, height };
		}
		if (format === "VP8L") {
			const bits =
				buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
			const width = 1 + (bits & 0x3fff);
			const height = 1 + ((bits >> 14) & 0x3fff);
			return { width, height };
		}
	} catch {
		/* noop */
	}
	return null;
}

// 保存済みファイルから「ファイルベースの品質シグナル」を算出
function fileQualityFromPath(filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		return { exists: false };
	}
	const buffer = fs.readFileSync(filePath);
	const bytes = buffer.length;
	const dims = readWebpDimensions(buffer);
	if (!dims || !dims.width || !dims.height) {
		return { exists: true, bytes, bytesPerPixel: null };
	}
	const pixels = dims.width * dims.height;
	const bytesPerPixel = pixels > 0 ? bytes / pixels : null;
	const tallRatio = dims.height / dims.width;
	return {
		exists: true,
		bytes,
		width: dims.width,
		height: dims.height,
		bytesPerPixel,
		tallRatio
	};
}

// ---------------------------------------
// ナビゲーション（多段フォールバック）
// ---------------------------------------
async function hasUsableDom(page) {
	try {
		return await page.evaluate(() => {
			const body = document.body;
			if (!body || body.childElementCount === 0) {
				return false;
			}
			const hasText = (body.innerText || "").trim().length > 20;
			const hasVisualContent = Boolean(
				body.querySelector(
					"main, section, article, header, footer, h1, img, picture, video, canvas, svg"
				)
			);
			return hasText || hasVisualContent;
		});
	} catch {
		return false;
	}
}

async function gotoWithFallback(page, url) {
	try {
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: PAGE_LOAD_TIMEOUT
		});
		// domcontentloaded 後にネットワークが落ち着くのを軽く待つ（取れれば）
		await page
			.waitForNetworkIdle({ idleTime: 600, timeout: 6000 })
			.catch(() => {});
		return;
	} catch (error) {
		console.log(`   ⚠️ domcontentloaded待機失敗。loadで再試行: ${error.message}`);
	}

	try {
		await page.goto(url, {
			waitUntil: "load",
			timeout: PAGE_LOAD_FALLBACK_TIMEOUT
		});
		console.log("   ✅ load再試行でナビゲーション完了");
		return;
	} catch (error) {
		console.log(`   ⚠️ load再試行も失敗。現在DOMを確認: ${error.message}`);
	}

	if (await hasUsableDom(page)) {
		console.log("   ✅ 描画済みDOMを確認したため撮影前処理を継続");
		return;
	}

	throw new Error("ナビゲーション失敗後も撮影可能なDOMを確認できませんでした");
}

// ---------------------------------------
// 待機・スクロール・lazyload
// ---------------------------------------
async function waitForFonts(page, timeout = FONTS_WAIT_TIMEOUT) {
	await page
		.evaluate(
			t =>
				Promise.race([
					(document.fonts && document.fonts.ready) || Promise.resolve(),
					new Promise(resolve => setTimeout(resolve, t))
				]),
			timeout
		)
		.catch(() => {});
}

async function scrollForLazyLoad(
	page,
	{
		maxTime = LAZYLOAD_MAX_TIME,
		step = SCROLL_STEP,
		interval = SCROLL_INTERVAL,
		maxDistance = null
	} = {}
) {
	await page.evaluate(
		({ maxTime, step, interval, maxDistance }) =>
			new Promise(resolve => {
				const startedAt = Date.now();
				const startedY = window.scrollY;
				let stalledCount = 0;

				const timer = setInterval(() => {
					const previousY = window.scrollY;
					window.scrollBy(0, step);

					const elapsed = Date.now() - startedAt;
					const distance = window.scrollY - startedY;
					const reachedBottom =
						window.scrollY + window.innerHeight >=
						document.documentElement.scrollHeight - 2;
					stalledCount = window.scrollY === previousY ? stalledCount + 1 : 0;
					const stoppedMoving = stalledCount >= 3;
					const reachedDistance =
						maxDistance !== null && distance >= maxDistance;

					if (
						elapsed >= maxTime ||
						reachedBottom ||
						stoppedMoving ||
						reachedDistance
					) {
						clearInterval(timer);
						resolve();
					}
				}, interval);
			}),
		{ maxTime, step, interval, maxDistance }
	);
}

async function waitForImages(page, timeout = IMAGE_WAIT_TIMEOUT) {
	await page.evaluate(timeout => {
		const images = Array.from(document.images);
		return Promise.race([
			Promise.allSettled(
				images.map(image => {
					if (image.complete) {
						return Promise.resolve();
					}
					return new Promise(resolve => {
						const finish = () => resolve();
						image.addEventListener("load", finish, { once: true });
						image.addEventListener("error", finish, { once: true });
						setTimeout(finish, timeout);
					});
				})
			),
			new Promise(resolve => setTimeout(resolve, timeout))
		]);
	}, timeout);
}

// 同意バナー等の代表的なオーバーレイを隠す（ファーストビュー品質対策・保守的）
async function hideConsentOverlays(page) {
	await page
		.evaluate(() => {
			const selectors = [
				"#onetrust-banner-sdk",
				"#onetrust-consent-sdk",
				"#CybotCookiebotDialog",
				".cc-window",
				"#cookie-notice",
				"#gdpr",
				'[aria-label*="cookie" i]',
				'[class*="cookie-consent" i]'
			];
			selectors.forEach(selector => {
				document.querySelectorAll(selector).forEach(el => {
					el.style.setProperty("display", "none", "important");
				});
			});
		})
		.catch(() => {});
}

// ScrollTrigger / AOS / リビール演出を「最終状態」に確定させる（Solvvy対策）
async function forceRevealAnimations(page) {
	await page
		.evaluate(() => {
			// アニメーション・トランジションを即時化
			const style = document.createElement("style");
			style.setAttribute("data-screenshot-reveal", "1");
			style.textContent =
				"*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;}";
			document.head.appendChild(style);

			// 代表的なライブラリを最終状態へ
			try {
				if (window.AOS && typeof window.AOS.refreshHard === "function") {
					window.AOS.refreshHard();
				}
			} catch {}
			try {
				const ST =
					window.ScrollTrigger ||
					(window.gsap && window.gsap.ScrollTrigger) ||
					(window.gsap &&
						window.gsap.core &&
						window.gsap.core.globals &&
						window.gsap.core.globals().ScrollTrigger);
				if (ST && typeof ST.refresh === "function") {
					ST.refresh();
				}
			} catch {}

			document
				.querySelectorAll("[data-aos]")
				.forEach(el => el.classList.add("aos-animate"));

			// 現在ほぼ不可視（opacity<0.15）だが中身を持つ要素＝リビール途中とみなして強制表示
			const candidates = Array.from(document.querySelectorAll("body *"));
			candidates.forEach(el => {
				if (el.getClientRects().length === 0) return;
				const cs = getComputedStyle(el);
				const opacity = parseFloat(cs.opacity);
				const hidden =
					(Number.isFinite(opacity) && opacity < 0.15) ||
					cs.visibility === "hidden";
				if (!hidden) return;
				const hasContent =
					el.textContent.trim().length > 0 ||
					el.querySelector("img,svg,picture,video,canvas");
				if (!hasContent) return;
				el.style.setProperty("opacity", "1", "important");
				el.style.setProperty("transform", "none", "important");
				el.style.setProperty("visibility", "visible", "important");
			});
		})
		.catch(() => {});
}

// ファーストビューに実際にピクセルが乗るまで待つ（白紙ヒーロー対策）
async function waitForHeroPainted(page, viewport, timeout = HERO_PAINT_TIMEOUT) {
	try {
		await page.waitForFunction(
			vh => {
				const cols = 6;
				const rows = 4;
				const w = window.innerWidth;
				let painted = 0;
				let total = 0;
				for (let i = 1; i <= cols; i++) {
					for (let j = 1; j <= rows; j++) {
						const x = (w * i) / (cols + 1);
						const y = (vh * j) / (rows + 1);
						total++;
						const el = document.elementFromPoint(x, y);
						if (!el) continue;
						const tag = el.tagName;
						if (
							["IMG", "PICTURE", "VIDEO", "CANVAS", "SVG", "IFRAME"].includes(
								tag
							)
						) {
							painted++;
							continue;
						}
						const cs = getComputedStyle(el);
						if (cs.backgroundImage && cs.backgroundImage !== "none") {
							painted++;
							continue;
						}
						if (el.textContent && el.textContent.trim().length > 0) {
							painted++;
						}
					}
				}
				return painted / total >= 0.25;
			},
			{ timeout, polling: 300 },
			viewport.height
		);
	} catch {
		/* タイムアウトしても撮影は続行（品質判定で拾う） */
	}
}

// ---------------------------------------
// ページ別 撮影前処理
// ---------------------------------------
async function prepareTopPage(page, viewport, waitScale = 1) {
	const base = Math.floor(TOP_INITIAL_WAIT * waitScale);

	await hideConsentOverlays(page);
	await wait(base);

	try {
		await page.waitForFunction(
			() =>
				document.documentElement.scrollHeight > window.innerHeight &&
				getComputedStyle(document.body).overflow !== "hidden",
			{ timeout: LAZYLOAD_MAX_TIME }
		);
	} catch {
		await page.evaluate(() => {
			const hasScrollableContent =
				document.body.scrollHeight > window.innerHeight ||
				Array.from(document.body.children).some(
					element => element.scrollHeight > window.innerHeight
				);
			if (
				hasScrollableContent &&
				document.documentElement.scrollHeight <= window.innerHeight
			) {
				document.documentElement.style.setProperty(
					"overflow",
					"visible",
					"important"
				);
				document.body.style.setProperty("overflow", "visible", "important");
			}
		});
	}

	await waitForHeroPainted(page, viewport);
	await wait(Math.floor(base / 2));

	// lazyload を全面的に発火させる
	await scrollForLazyLoad(page, {
		step: Math.max(80, Math.floor(SCROLL_STEP / 2)),
		interval: SCROLL_INTERVAL * 2
	});
	await waitForImages(page);
	await waitForFonts(page);

	// リビール演出を最終状態に確定 → 先頭へ戻す
	await forceRevealAnimations(page);
	await wait(Math.floor(base / 2));

	await page.evaluate(() => window.scrollTo(0, 0));
	await wait(SCROLL_INTERVAL * 2);
}

async function prepareSubPage(page, waitScale = 1) {
	await hideConsentOverlays(page);
	await scrollForLazyLoad(page);
	await waitForImages(page);
	await waitForFonts(page);
	await forceRevealAnimations(page);
	await page.evaluate(() => window.scrollTo(0, 0));
	await wait(Math.floor(SCROLL_INTERVAL * 2 * waitScale));
}

// ---------------------------------------
// DOM ベースの品質シグナル（先頭ビュー＝ヒーロー中心）
// ---------------------------------------
async function analyzePageDom(page, viewport) {
	try {
		return await page.evaluate(vh => {
			window.scrollTo(0, 0);

			const isWhite = color => {
				const m = String(color).match(
					/(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/
				);
				if (!m) return true;
				const a = m[4] === undefined ? 1 : parseFloat(m[4]);
				if (a < 0.05) return true; // 透明は下地(白)とみなす
				const [r, g, b] = [+m[1], +m[2], +m[3]];
				return r > 245 && g > 245 && b > 245;
			};

			const textTags = new Set([
				"H1", "H2", "H3", "H4", "H5", "H6", "P", "SPAN", "A", "LI",
				"BUTTON", "STRONG", "EM", "SMALL", "LABEL", "TD", "TH",
				"FIGCAPTION", "BLOCKQUOTE"
			]);

			const paintedAt = (x, y) => {
				const el = document.elementFromPoint(x, y);
				if (!el) return false;
				const tag = el.tagName;
				if (
					["IMG", "PICTURE", "VIDEO", "CANVAS", "SVG", "IFRAME"].includes(tag)
				) {
					return true;
				}
				const cs = getComputedStyle(el);
				if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
				if (!isWhite(cs.backgroundColor)) return true;
				if (textTags.has(tag) && el.textContent.trim().length > 0) return true;
				return false;
			};

			const cols = 8;
			const rows = 6;
			const w = window.innerWidth;
			let painted = 0;
			let total = 0;
			for (let i = 1; i <= cols; i++) {
				for (let j = 1; j <= rows; j++) {
					total++;
					if (paintedAt((w * i) / (cols + 1), (vh * j) / (rows + 1))) {
						painted++;
					}
				}
			}
			const heroBlankRatio = total ? 1 - painted / total : 1;

			// 演出技術の検出
			const hasVideoHero = Array.from(document.querySelectorAll("video")).some(
				v => {
					const r = v.getBoundingClientRect();
					return r.top < vh && r.bottom > 0 && r.width > 200 && r.height > 150;
				}
			);

			const canvases = Array.from(document.querySelectorAll("canvas"));
			const hasWebGL =
				!!(window.THREE || window.PIXI || window.Babylon) ||
				canvases.some(c => {
					try {
						return !!(
							c.getContext("webgl") || c.getContext("webgl2")
						);
					} catch {
						return false;
					}
				});

			const hasScrollTrigger =
				!!(
					window.ScrollTrigger ||
					(window.gsap && window.gsap.ScrollTrigger) ||
					window.AOS ||
					window.locomotive ||
					window.LocomotiveScroll
				) ||
				!!document.querySelector(
					"[data-aos],[data-scroll],[data-animate],[data-sr],.aos-init,.reveal,.is-inview"
				);

			const animationHeavy =
				hasScrollTrigger ||
				hasWebGL ||
				hasVideoHero ||
				canvases.length > 0;

			return {
				heroBlankRatio,
				heroSamplePainted: painted,
				heroSampleTotal: total,
				hasVideoHero,
				hasWebGL,
				hasScrollTrigger,
				animationHeavy,
				canvasCount: canvases.length
			};
		}, viewport.height);
	} catch (error) {
		return { error: error.message };
	}
}

// DOM シグナル + ファイルシグナルを統合して品質ステータスを判定
function evaluateQuality(domSignals, fileQuality) {
	const issues = [];
	let status = "ok";
	const bump = next => {
		const rank = { ok: 0, warn: 1, fail: 2 };
		if (rank[next] > rank[status]) status = next;
	};

	if (!fileQuality || !fileQuality.exists) {
		return { status: "fail", issues: ["no-file"] };
	}

	// DOM: 先頭ビュー空白（最も信頼できる一次シグナル）
	const hero =
		domSignals && typeof domSignals.heroBlankRatio === "number"
			? domSignals.heroBlankRatio
			: null;
	if (hero !== null) {
		if (hero >= HERO_BLANK_FAIL) {
			bump("fail");
			issues.push("hero-blank");
		} else if (hero >= HERO_BLANK_WARN) {
			bump("warn");
			issues.push("hero-sparse");
		}
	}

	// ファイル: bytes/pixel（白紙の補強シグナル）
	// 単独では fail にしない。DOMが「ヒーローに中身あり」と言う場合は無視する。
	// （写真の少ないミニマルな正常ページの誤検知を避ける）
	const bpp = fileQuality.bytesPerPixel;
	if (typeof bpp === "number" && bpp < BPP_FAIL) {
		if (hero === null || hero >= HERO_BLANK_WARN) {
			bump("fail");
			issues.push("low-density");
		} else if (hero >= 0.5) {
			bump("warn");
			issues.push("low-density");
		}
		// hero < 0.5 はDOMが中身を確認しているため bpp は無視
	} else if (
		typeof bpp === "number" &&
		bpp < BPP_WARN &&
		(fileQuality.tallRatio || 0) >= TALL_RATIO
	) {
		bump("warn");
		issues.push("tall-and-sparse");
	}

	// 動画ヒーローは静止画では破綻しやすい
	if (domSignals && domSignals.hasVideoHero) {
		issues.push("video-hero");
	}

	return { status, issues: [...new Set(issues)] };
}

// ---------------------------------------
// 撮影（1ビューポート分。リトライ込み）
// ---------------------------------------
async function captureViewport(page, { url, outputPath, pageInfo, viewport }) {
	let lastError = null;
	let domSignals = null;

	for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
		const waitScale = 1 + (attempt - 1) * 0.8; // 2回目は待機を延長
		try {
			await page.bringToFront();
			await gotoWithFallback(page, url);

			if (isTopPage(pageInfo)) {
				await prepareTopPage(page, viewport, waitScale);
			} else {
				await prepareSubPage(page, waitScale);
			}

			domSignals = await analyzePageDom(page, viewport);

			await page.screenshot({
				path: outputPath,
				type: "webp",
				quality: 80,
				fullPage: true
			});

			const fileQuality = fileQualityFromPath(outputPath);
			const quality = evaluateQuality(domSignals, fileQuality);

			if (quality.status !== "fail" || attempt === MAX_CAPTURE_ATTEMPTS) {
				return { ok: true, domSignals, fileQuality, quality, attempts: attempt };
			}
			console.log(
				`   🔁 品質fail(${quality.issues.join(",")})のため再撮影 (${attempt}/${MAX_CAPTURE_ATTEMPTS})`
			);
		} catch (error) {
			lastError = error;
			console.log(`   ❌ 撮影失敗(試行${attempt}): ${error.message}`);
		}
	}

	// 全試行でこの実行の撮影に失敗。既存(古い)ファイルを成功扱いにしない。
	return {
		ok: false,
		domSignals,
		fileQuality: { exists: false },
		quality: {
			status: "fail",
			issues: [lastError ? "capture-error" : "fail"]
		},
		attempts: MAX_CAPTURE_ATTEMPTS,
		error: lastError ? lastError.message : null
	};
}

// ---------------------------------------
// analysis のマージ（既存値を壊さない）
// ---------------------------------------
function combineStatus(a, b) {
	const rank = { ok: 0, warn: 1, fail: 2 };
	const ra = a ? rank[a.status] ?? -1 : -1;
	const rb = b ? rank[b.status] ?? -1 : -1;
	if (ra < 0 && rb < 0) return "unknown";
	return rb > ra ? b.status : a.status;
}

function buildAnalysis(existingAnalysis, results) {
	const existing = existingAnalysis || {};
	const checked = existing.checked || {};
	const manual = checked.manual === true;

	const { pc, sp } = results;
	const sides = [pc, sp].filter(Boolean);

	// 有効なDOMシグナルが1つも取れていない場合は、既存の自動フラグを下げない
	const haveDom = sides.some(r => r.domSignals && !r.domSignals.error);

	const anyDom = key => sides.some(r => r.domSignals && r.domSignals[key]);
	const animationHeavy = anyDom("animationHeavy");
	const hasWebGL = anyDom("hasWebGL");
	const hasScrollTrigger = anyDom("hasScrollTrigger");
	const hasVideoHero = anyDom("hasVideoHero");

	const overall = combineStatus(
		pc ? pc.quality : null,
		sp ? sp.quality : null
	);

	// 動画候補の自動判定:
	//   - 静止画品質が fail（白紙/低密度）で安定しない
	//   - ヒーローが動画 / WebGL（静止画では本質的に破綻）
	const needsVideoAuto = overall === "fail" || hasVideoHero || hasWebGL;

	const screenshotQuality = {
		overall,
		evaluatedAt: new Date().toISOString(),
		source: "dom+file",
		pc: pc ? sideQuality(pc) : existing.screenshotQuality?.pc || null,
		sp: sp ? sideQuality(sp) : existing.screenshotQuality?.sp || null
	};

	// 自動フラグの決定:
	//   - manual=true → 既存値を尊重（自動で上書きしない）
	//   - DOMシグナルあり → 今回の検出結果で更新（再撮影で最新化）
	//   - DOMシグナルなし → 既存値を保持（劣化させない）
	const resolveAuto = (existingValue, detected) => {
		if (manual) return existingValue;
		if (!haveDom) return existingValue;
		return detected;
	};

	return {
		...existing,
		needsVideo: resolveAuto(existing.needsVideo, needsVideoAuto),
		animationHeavy: resolveAuto(existing.animationHeavy, animationHeavy),
		hasWebGL: resolveAuto(existing.hasWebGL, hasWebGL),
		hasScrollTrigger: resolveAuto(existing.hasScrollTrigger, hasScrollTrigger),
		screenshotQuality,
		checked: {
			...checked,
			auto: true,
			manual: checked.manual === true
		}
	};
}

function sideQuality(result) {
	const dom = result.domSignals || {};
	const file = result.fileQuality || {};
	return {
		status: result.quality ? result.quality.status : "unknown",
		issues: result.quality ? result.quality.issues : [],
		heroBlankRatio:
			typeof dom.heroBlankRatio === "number"
				? Number(dom.heroBlankRatio.toFixed(3))
				: null,
		bytesPerPixel:
			typeof file.bytesPerPixel === "number"
				? Number(file.bytesPerPixel.toFixed(5))
				: null,
		width: file.width || null,
		height: file.height || null,
		attempts: result.attempts || null
	};
}

function saveScreenshotRecord({ url, slug, pathname, depth, pcUIPath, spUIPath, results }) {
	const existingRecord = db[url] || {};
	const existingMeta = existingRecord.meta || {};
	const existingAssets = existingRecord.assets || {};
	const existingImage = existingAssets.image || {};

	db[url] = {
		...existingRecord,
		meta: {
			...existingMeta,
			url,
			domain,
			slug,
			path: pathname,
			depth,
			capturedAt: new Date().toISOString()
		},
		assets: {
			...existingAssets,
			image: {
				...existingImage,
				pc: pcUIPath,
				sp: spUIPath
			},
			video: existingAssets.video || { pc: null, sp: null },
			thumb: existingAssets.thumb || { pc: null, sp: null }
		},
		analysis: buildAnalysis(existingRecord.analysis, results),
		tags: existingRecord.tags || []
	};
}

// 再撮影が必要か（既存画像を尊重）
function shouldCapture(url, hasPC, hasSP) {
	if (RECAPTURE === "1" || RECAPTURE === "all") return true;
	if (!hasPC || !hasSP) return true;
	if (RECAPTURE === "fail") {
		const overall = db[url]?.analysis?.screenshotQuality?.overall;
		return overall === "fail" || overall === undefined;
	}
	return false;
}

// ---------------------------------------
// メイン処理
// ---------------------------------------
(async () => {
	const browser = await puppeteer.launch({
		headless: true,
		// 収集対象に証明書不備のサイトが混ざっても撮影を止めない
		acceptInsecureCerts: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"]
	});

	const failures = [];
	const summary = [];

	try {
		const pagePC = await browser.newPage();
		const pageSP = await browser.newPage();

		await pagePC.setUserAgent(VIEWPORTS.pc.userAgent);
		await pagePC.setViewport({ width: VIEWPORTS.pc.width, height: VIEWPORTS.pc.height });
		await pageSP.setUserAgent(VIEWPORTS.sp.userAgent);
		await pageSP.setViewport({ width: VIEWPORTS.sp.width, height: VIEWPORTS.sp.height });

		let count = 0;
		for (const url of urls) {
			count++;

			const urlObj = new URL(url);
			const slug = toSafeSlug(url);
			const pathname = urlObj.pathname;
			const depth = pathname.split("/").filter(Boolean).length;
			const pageInfo = { slug, pathname, depth };

			const saveDir = path.join("screenshots", domain, slug);
			const baseName = `${domain}_${slug}`;
			const pcFsPath = path.join(saveDir, `${baseName}_pc.webp`);
			const spFsPath = path.join(saveDir, `${baseName}_sp.webp`);
			const pcUIPath = `../${pcFsPath.replace(/\\/g, "/")}`;
			const spUIPath = `../${spFsPath.replace(/\\/g, "/")}`;

			const hasPC = fs.existsSync(pcFsPath);
			const hasSP = fs.existsSync(spFsPath);

			if (!shouldCapture(url, hasPC, hasSP)) {
				console.log(`⏭ (${count}/${urls.length}) スキップ: ${url}`);
				continue;
			}

			console.log(`📸 (${count}/${urls.length}) 撮影中: ${url}`);
			fs.mkdirSync(saveDir, { recursive: true });

			const results = { pc: null, sp: null };

			try {
				results.pc = await captureViewport(pagePC, {
					url,
					outputPath: pcFsPath,
					pageInfo,
					viewport: VIEWPORTS.pc
				});
			} catch (error) {
				console.log("   ❌ PC致命的失敗:", error.message);
			}

			try {
				results.sp = await captureViewport(pageSP, {
					url,
					outputPath: spFsPath,
					pageInfo,
					viewport: VIEWPORTS.sp
				});
			} catch (error) {
				console.log("   ❌ SP致命的失敗:", error.message);
			}

			if (fs.existsSync(pcFsPath) || fs.existsSync(spFsPath)) {
				saveScreenshotRecord({
					url,
					slug,
					pathname,
					depth,
					pcUIPath,
					spUIPath,
					results
				});
			}

			// サマリ・失敗ログ
			["pc", "sp"].forEach(side => {
				const r = results[side];
				if (!r) {
					failures.push({ url, side, reason: "capture-threw" });
					return;
				}
				const q = r.quality || {};
				summary.push({ url, side, status: q.status, issues: q.issues });
				if (q.status === "fail" || !r.ok) {
					failures.push({
						url,
						side,
						reason: r.error || (q.issues || []).join(",") || "fail",
						quality: q.status,
						attempts: r.attempts
					});
				}
			});

			const pcS = results.pc?.quality?.status || "-";
			const spS = results.sp?.quality?.status || "-";
			console.log(`   → 品質 PC:${pcS} / SP:${spS}`);
		}
	} finally {
		await browser.close();
		fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

		const runId = new Date().toISOString().replace(/[:.]/g, "-");
		const logPath = path.join(LOG_DIR, `capture_${domain}_${runId}.json`);
		const latestPath = path.join(LOG_DIR, `capture_${domain}.latest.json`);
		const logData = {
			domain,
			sitemap: SITEMAP_FILE,
			runAt: new Date().toISOString(),
			recaptureMode: RECAPTURE || "missing-only",
			total: summary.length,
			failures,
			summary
		};
		fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
		fs.writeFileSync(latestPath, JSON.stringify(logData, null, 2));
		console.log("\n💾 DB保存:", DB_FILE);
		console.log("🪵 ログ:", logPath);
		if (failures.length) {
			console.log(`⚠️ 要確認(失敗/低品質): ${failures.length}件`);
			failures.forEach(f =>
				console.log(`   - [${f.side}] ${f.url} (${f.reason})`)
			);
		}
	}

	console.log("✅ 完了！");
})().catch(error => {
	console.error("❌ バッチ処理に失敗しました:", error);
	process.exitCode = 1;
});
