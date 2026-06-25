const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/**
 * ============================================================
 * record_top.js — TOPページ動画録画 PoC
 * ------------------------------------------------------------
 * 静止画では拾えないTOPの動き（ヒーロー動画・スクロール演出）を
 * 自動スクロール録画して mp4 で保存し、既存 screenshots_db /
 * gallery スキーマに統合する。
 *
 * 使い方:
 *   node record_top.js https://hikarina.co.jp/
 *   node record_top.js https://hikarina.co.jp/ --mode=frames --only=sp
 *
 * 既存レコードへの統合（重複レコード防止）:
 *   録画前に screenshots_db/*.json を走査し、対象URLに対応する
 *   既存レコードを優先順位付きで探す。
 *     1) 完全一致URL
 *     2) www有無を無視したURL一致（同一path）
 *     3) domain正規化後に一致（TOP限定）
 *   見つかった場合は新規JSONを作らず、既存レコードの meta.domain を
 *   正準ドメインとして採用し、保存先・DBキー・相対パスをそれに揃える。
 *   見つからない場合のみ入力URL由来のドメインで新規作成する。
 *
 * 保存先（正準ドメイン基準）:
 *   screenshots/<domain>/top/<domain>_top_pc.mp4
 *   screenshots/<domain>/top/<domain>_top_sp.mp4
 *
 * DB 書き戻し（既存値は壊さない）:
 *   screenshots_db/<domain>.json の既存URLキーに
 *   assets.video.pc / assets.video.sp（gallery相対パス）を追記。
 *   assets.image / assets.thumb / tags / _site.tags / analysis.checked は保持。
 *   analysis.needsVideo = true。
 *
 * 依存:
 *   通常は page.screencast()（Puppeteer ネイティブ）+ ffmpeg。
 *   --mode=frames 指定時のみ、PNG/JPEGフレーム連番 → ffmpeg mp4化を使う。
 *   ffmpeg は ffmpeg-static があればそれを、無ければ PATH の ffmpeg を使う。
 *
 * 実行環境:
 *   Node.js 18以上。推奨は Node.js 20 LTS / 22 LTS。
 *   Puppeteer は CommonJS / ESM 差異を吸収するため dynamic import で読み込む。
 * ============================================================
 */

// page.screencast と録画後処理で同じ ffmpeg を使う。
let FFMPEG_PATH = "ffmpeg";
try {
	const ffmpegPath = require("ffmpeg-static");
	if (ffmpegPath) {
		FFMPEG_PATH = ffmpegPath;
		process.env.PATH = path.dirname(ffmpegPath) + path.delimiter + process.env.PATH;
	}
} catch {
	// ffmpeg-static 未導入ならシステムの ffmpeg を期待
}

// ---------------------------------------
// 設定
// ---------------------------------------
const PAGE_LOAD_TIMEOUT = 30000;
const PAGE_LOAD_FALLBACK_TIMEOUT = 15000;
const HERO_WAIT = 3000;
const LAZYLOAD_MAX_TIME = 8000;
const IMAGE_WAIT_TIMEOUT = 5000;

// 録画テンポ。静止画では伝わらないヒーローとスクロール演出を
// gallery上で追いやすいよう、PoC初版よりゆっくりめにする。
const HERO_HOLD_MS = 2800;
const SCROLL_DURATION_MS = 18000;
const END_HOLD_MS = 1000;
const FPS = 25;
const SCROLL_STEP_INTERVAL = 120; // スクロール1ステップ間隔(ms)

// screencastが短尺・途中停止しやすいサイト向けのfallback録画方式。
// 一時JPEGフレームを作り、ffmpegでH.264/yuv420p/faststartへ変換する。
const FRAMES_FPS = 18;
const FRAMES_CRF = 26;
const FRAMES_JPEG_QUALITY = 82;
const FRAMES_HERO_HOLD_MS = 3200;
const FRAMES_SCROLL_DURATION_MS = 22000;
const FRAMES_END_HOLD_MS = 1200;
const FRAMES_TMP_ROOT = path.join(".tmp", "record_frames");

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
// 引数
// ---------------------------------------
const cliArgs = process.argv.slice(2);
const TARGET_URL = cliArgs.find(arg => !arg.startsWith("--"));
if (!TARGET_URL) {
	console.error("❌ URL を指定してください");
	console.error("   例: node record_top.js https://hikarina.co.jp/");
	console.error("   例: node record_top.js https://hikarina.co.jp/ --mode=frames --only=sp");
	process.exit(1);
}

const cliOptions = new Map(
	cliArgs
		.filter(arg => arg.startsWith("--"))
		.map(arg => {
			const [key, value = "true"] = arg.slice(2).split("=");
			return [key, value];
		})
);

const RECORD_MODE = cliOptions.get("mode") || "screencast";
const ONLY_VIEWPORT = cliOptions.get("only") || "both";
if (!["screencast", "frames"].includes(RECORD_MODE)) {
	console.error(`❌ --mode は screencast または frames を指定してください: ${RECORD_MODE}`);
	process.exit(1);
}
if (!["pc", "sp", "both"].includes(ONLY_VIEWPORT)) {
	console.error(`❌ --only は pc / sp / both を指定してください: ${ONLY_VIEWPORT}`);
	process.exit(1);
}

let urlObj;
try {
	urlObj = new URL(TARGET_URL);
} catch {
	console.error("❌ URL が不正です:", TARGET_URL);
	process.exit(1);
}

const slug = "top";
const DB_DIR = "./screenshots_db";
const TEMP_SUFFIX = `${process.pid}-${Date.now()}`;

// 以下は既存DB検索（resolveTarget）後に確定する。
// 既存レコードが見つかった場合は入力URL由来ではなく
// 既存レコードの meta.domain を正準ドメインとして採用し、
// 動画の保存先・DB書き込み先・相対パスをそれに揃える。
let domain;
let saveDir;
let baseName;
let pcFsPath;
let spFsPath;
let pcUIPath;
let spUIPath;
let DB_FILE;
let dbKey; // DBへ書き込むURLキー（既存レコードがあればそのキーを保持）
let matchedRecord = null; // 既存レコード（無ければ null = 新規作成）

// ---------------------------------------
// ユーティリティ
// ---------------------------------------
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------
// URL正規化 / 既存レコード検索
// ---------------------------------------
// www有無を無視するためホスト先頭の "www." を除去し小文字化する。
function normalizeHost(host) {
	return host.toLowerCase().replace(/^www\./, "");
}

// 末尾スラッシュの有無を吸収する。ルートは "" に正規化する。
function normalizePath(pathname) {
	return (pathname || "").replace(/\/+$/, "");
}

// 対象レコードがTOPページかどうか。優先順位3（ドメイン一致）の
// 誤マッチを防ぐためのガード。
function isTopRecord(record, urlKey) {
	const meta = (record && record.meta) || {};
	if (meta.slug === "top") return true;
	if (meta.depth === 0) return true;
	if (normalizePath(meta.path || "") === "") return true;
	try {
		if (normalizePath(new URL(urlKey).pathname) === "") return true;
	} catch {
		// URLとして解釈できないキーはTOP扱いしない
	}
	return false;
}

/**
 * screenshots_db/*.json を走査し、録画対象URLに対応する既存レコードを
 * 優先順位付きで探す。
 *
 *   1) 完全一致URL                       key === targetUrl
 *   2) www有無を無視したURL一致（同一path） normHost一致 かつ 同一normPath
 *   3) domain正規化後に一致（TOP限定）    normHost一致 かつ TOP
 *                                         かつ（同一normPath または ルート）
 *
 * 戻り値: { file, key, record, matchedBy } または null
 */
function findExistingRecord(targetUrl) {
	let target;
	try {
		target = new URL(targetUrl);
	} catch {
		return null;
	}
	const tHost = normalizeHost(target.hostname);
	const tPath = normalizePath(target.pathname);

	if (!fs.existsSync(DB_DIR)) return null;
	const files = fs
		.readdirSync(DB_DIR)
		.filter(f => f.endsWith(".json") && f !== "index.json");

	let exact = null;
	let wwwMatch = null;
	let domainMatch = null;

	for (const file of files) {
		let db;
		try {
			db = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), "utf-8"));
		} catch {
			continue; // 壊れたJSONはスキップ
		}
		for (const key of Object.keys(db)) {
			if (key === "_site") continue;
			const record = db[key];

			if (!exact && key === targetUrl) {
				exact = { file, key, record, matchedBy: "exact" };
			}

			let keyUrl;
			try {
				keyUrl = new URL(key);
			} catch {
				continue;
			}
			if (normalizeHost(keyUrl.hostname) !== tHost) continue;
			const kPath = normalizePath(keyUrl.pathname);

			if (!wwwMatch && kPath === tPath) {
				wwwMatch = { file, key, record, matchedBy: "www-insensitive" };
			}
			if (
				!domainMatch &&
				isTopRecord(record, key) &&
				(kPath === tPath || kPath === "")
			) {
				domainMatch = { file, key, record, matchedBy: "domain" };
			}
		}
	}

	return exact || wwwMatch || domainMatch || null;
}

// 既存DB検索の結果に応じて、保存先・DBキー・相対パスを確定する。
function resolveTarget() {
	const match = findExistingRecord(TARGET_URL);
	if (match) {
		matchedRecord = match.record;
		domain =
			(match.record.meta && match.record.meta.domain) ||
			match.file.replace(/\.json$/, "");
		DB_FILE = `${DB_DIR}/${match.file}`;
		dbKey = match.key;
		console.log(
			`🔁 既存レコードへ統合 (${match.matchedBy}): ${match.file} [${match.key}]`
		);
		console.log(`   正準ドメイン: ${domain}`);
	} else {
		domain = urlObj.hostname.replace(/\./g, "_");
		DB_FILE = `${DB_DIR}/${domain}.json`;
		dbKey = TARGET_URL;
		console.log(`🆕 既存レコードなし。新規作成: ${domain}.json`);
	}

	saveDir = path.join("screenshots", domain, slug);
	baseName = `${domain}_${slug}`;
	pcFsPath = path.join(saveDir, `${baseName}_pc.mp4`);
	spFsPath = path.join(saveDir, `${baseName}_sp.mp4`);
	pcUIPath = `../${pcFsPath.replace(/\\/g, "/")}`;
	spUIPath = `../${spFsPath.replace(/\\/g, "/")}`;
}

async function loadPuppeteer() {
	const module = await import("puppeteer");
	return module.default || module;
}

function removeFileIfExists(filePath) {
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

function removeDirIfExists(dirPath) {
	if (fs.existsSync(dirPath)) {
		fs.rmSync(dirPath, { recursive: true, force: true });
	}
}

function selectedViewportKeys() {
	if (ONLY_VIEWPORT === "both") return ["pc", "sp"];
	return [ONLY_VIEWPORT];
}

function parseDurationSeconds(value) {
	const match = String(value).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
	if (!match) return null;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function encodeVideo(inputPath, outputPath) {
	// Puppeteerのscreencast出力はVP9/gbrp/MOVで、Safari・Firefoxでは再生不可。
	// gallery配信用にH.264/yuv420pへ再エンコードし、全主要ブラウザで再生できる
	// mp4へ正規化する。yuv420pはハードウェアデコード互換、+faststartで先頭再生可。
	await execFileAsync(
		FFMPEG_PATH,
		[
			"-y",
			"-v",
			"error",
			"-i",
			inputPath,
			"-map",
			"0:v:0",
			"-c:v",
			"libx264",
			"-profile:v",
			"main",
			"-pix_fmt",
			"yuv420p",
			"-crf",
			"20",
			"-preset",
			"veryfast",
			"-movflags",
			"+faststart",
			outputPath
		],
		{ maxBuffer: 10 * 1024 * 1024 }
	);
}

async function encodeFramesToVideo(framesDir, outputPath) {
	await execFileAsync(
		FFMPEG_PATH,
		[
			"-y",
			"-v",
			"error",
			"-framerate",
			String(FRAMES_FPS),
			"-i",
			path.join(framesDir, "frame_%05d.jpg"),
			"-map",
			"0:v:0",
			"-c:v",
			"libx264",
			"-profile:v",
			"main",
			"-pix_fmt",
			"yuv420p",
			"-vf",
			"scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
			"-crf",
			String(FRAMES_CRF),
			"-preset",
			"veryfast",
			"-movflags",
			"+faststart",
			outputPath
		],
		{ maxBuffer: 10 * 1024 * 1024 }
	);
}

async function validateVideo(filePath, expectedViewport) {
	const bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
	if (bytes <= 0) {
		throw new Error("生成ファイルが空です");
	}

	// ffmpegの入力情報からdurationと解像度を取得し、そのまま全フレームを
	// null出力へデコードする。終了コード0で最後までdecodeできたと判断する。
	const { stderr } = await execFileAsync(
		FFMPEG_PATH,
		["-hide_banner", "-i", filePath, "-map", "0:v:0", "-f", "null", "-"],
		{ maxBuffer: 20 * 1024 * 1024 }
	);

	const durationMatch = stderr.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
	const duration = durationMatch ? parseDurationSeconds(durationMatch[1]) : null;
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error(`durationが有限ではありません: ${durationMatch?.[1] || "取得不可"}`);
	}

	const videoStreamLine = stderr
		.split("\n")
		.find(line => /Stream #.*Video:/.test(line));

	// コーデックとピクセルフォーマットを検証する。screencstの素のVP9/gbrpが
	// そのまま配信されると主要ブラウザで再生できないため、再エンコード後に
	// h264 / yuv420p であることを必須化する。
	const codecMatch = videoStreamLine?.match(/Video:\s*([a-z0-9]+)/i);
	const codecName = codecMatch ? codecMatch[1].toLowerCase() : null;
	if (codecName !== "h264") {
		throw new Error(`コーデックが不正です: ${codecName || "取得不可"} (期待値 h264)`);
	}

	const pixFmtMatch = videoStreamLine?.match(/Video:\s*[a-z0-9]+[^,]*,\s*([a-z0-9]+)/i);
	const pixFmt = pixFmtMatch ? pixFmtMatch[1].toLowerCase() : null;
	if (pixFmt !== "yuv420p") {
		throw new Error(`pix_fmtが不正です: ${pixFmt || "取得不可"} (期待値 yuv420p)`);
	}

	const dimensionsMatch = videoStreamLine?.match(/,\s*(\d{2,5})x(\d{2,5})(?:[,\s])/);
	const width = dimensionsMatch ? Number(dimensionsMatch[1]) : null;
	const height = dimensionsMatch ? Number(dimensionsMatch[2]) : null;
	if (width !== expectedViewport.width || height !== expectedViewport.height) {
		throw new Error(
			`解像度が不正です: ${width || "?"}x${height || "?"} ` +
				`(期待値 ${expectedViewport.width}x${expectedViewport.height})`
		);
	}

	return { bytes, duration, width, height, codecName, pixFmt };
}

function installValidatedVideos(results) {
	const backups = [];
	const installed = [];
	let completed = false;

	try {
		for (const result of results) {
			const backupPath = `${result.outPath}.${TEMP_SUFFIX}.backup`;
			removeFileIfExists(backupPath);

			if (fs.existsSync(result.outPath)) {
				fs.renameSync(result.outPath, backupPath);
				backups.push({ backupPath, outPath: result.outPath });
			}

			fs.renameSync(result.validatedPath, result.outPath);
			installed.push(result.outPath);
		}
		completed = true;
	} finally {
		if (!completed) {
			installed.forEach(removeFileIfExists);
			for (const backup of backups.reverse()) {
				if (fs.existsSync(backup.backupPath)) {
					fs.renameSync(backup.backupPath, backup.outPath);
				}
			}
		} else {
			backups.forEach(backup => removeFileIfExists(backup.backupPath));
		}
	}
}

async function gotoWithFallback(page, url) {
	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
		await page.waitForNetworkIdle({ idleTime: 600, timeout: 6000 }).catch(() => {});
		return;
	} catch (error) {
		console.log(`   ⚠️ domcontentloaded失敗。loadで再試行: ${error.message}`);
	}
	await page.goto(url, { waitUntil: "load", timeout: PAGE_LOAD_FALLBACK_TIMEOUT });
}

async function waitForImages(page, timeout = IMAGE_WAIT_TIMEOUT) {
	await page.evaluate(timeout => {
		const images = Array.from(document.images);
		return Promise.race([
			Promise.allSettled(
				images.map(image =>
					image.complete
						? Promise.resolve()
						: new Promise(resolve => {
								image.addEventListener("load", resolve, { once: true });
								image.addEventListener("error", resolve, { once: true });
								setTimeout(resolve, timeout);
						  })
				)
			),
			new Promise(resolve => setTimeout(resolve, timeout))
		]);
	}, timeout);
}

// 録画前準備: ヒーロー待ち → lazyload発火 → 先頭へ戻す
async function preparePage(page) {
	await wait(HERO_WAIT);
	await page.evaluate(
		maxTime =>
			new Promise(resolve => {
				const start = Date.now();
				const timer = setInterval(() => {
					window.scrollBy(0, 400);
					const bottom =
						window.scrollY + window.innerHeight >=
						document.documentElement.scrollHeight - 2;
					if (bottom || Date.now() - start > maxTime) {
						clearInterval(timer);
						resolve();
					}
				}, 100);
			}),
		LAZYLOAD_MAX_TIME
	);
	await waitForImages(page);
	await page.evaluate(() => window.scrollTo(0, 0));
	await wait(500);
}

// 自動スクロール（録画中に呼ぶ）: 先頭 → 最下部
async function autoScrollDown(page, durationMs = SCROLL_DURATION_MS) {
	await page.evaluate(() => window.scrollTo(0, 0));
	const metrics = await page.evaluate(() => ({
		total: document.documentElement.scrollHeight,
		vh: window.innerHeight
	}));
	const distance = Math.max(0, metrics.total - metrics.vh);
	if (distance === 0) {
		await wait(durationMs);
		return;
	}
	const steps = Math.max(1, Math.round(durationMs / SCROLL_STEP_INTERVAL));
	const per = distance / steps;
	for (let i = 1; i <= steps; i++) {
		await page.evaluate(y => window.scrollTo(0, y), Math.round(per * i));
		await wait(SCROLL_STEP_INTERVAL);
	}
}

async function captureFrame(page, framePath) {
	await page.screenshot({
		path: framePath,
		type: "jpeg",
		quality: FRAMES_JPEG_QUALITY,
		captureBeyondViewport: false
	});
}

async function recordFrames(page, framesDir) {
	removeDirIfExists(framesDir);
	fs.mkdirSync(framesDir, { recursive: true });

	await page.evaluate(() => window.scrollTo(0, 0));
	const frameIntervalMs = 1000 / FRAMES_FPS;
	let frameIndex = 0;

	const capture = async () => {
		const framePath = path.join(
			framesDir,
			`frame_${String(frameIndex).padStart(5, "0")}.jpg`
		);
		await captureFrame(page, framePath);
		frameIndex++;
	};

	const captureHold = async durationMs => {
		const frames = Math.max(1, Math.round(durationMs / frameIntervalMs));
		for (let i = 0; i < frames; i++) {
			await capture();
			await wait(frameIntervalMs);
		}
	};

	const metrics = await page.evaluate(() => ({
		total: document.documentElement.scrollHeight,
		vh: window.innerHeight
	}));
	const distance = Math.max(0, metrics.total - metrics.vh);

	await captureHold(FRAMES_HERO_HOLD_MS);

	if (distance > 0) {
		const scrollFrames = Math.max(1, Math.round(FRAMES_SCROLL_DURATION_MS / frameIntervalMs));
		for (let i = 1; i <= scrollFrames; i++) {
			const y = Math.round((distance * i) / scrollFrames);
			await page.evaluate(nextY => window.scrollTo(0, nextY), y);
			await wait(frameIntervalMs);
			await capture();
		}
	} else {
		await captureHold(FRAMES_SCROLL_DURATION_MS);
	}

	await captureHold(FRAMES_END_HOLD_MS);
	return frameIndex;
}

async function recordViewport(browser, key) {
	const vp = VIEWPORTS[key];
	const outPath = key === "pc" ? pcFsPath : spFsPath;
	const rawPath = path.join(saveDir, `.${baseName}_${key}.${TEMP_SUFFIX}.raw.mp4`);
	const encodedPath = path.join(saveDir, `.${baseName}_${key}.${TEMP_SUFFIX}.h264.mp4`);
	const framesDir = path.join(FRAMES_TMP_ROOT, `${baseName}_${key}_${TEMP_SUFFIX}`);
	let keepEncoded = false;

	const page = await browser.newPage();
	try {
		await page.setUserAgent(vp.userAgent);
		await page.setViewport({ width: vp.width, height: vp.height });

		console.log(`🎬 [${key.toUpperCase()}] 録画準備: ${TARGET_URL}`);
		await gotoWithFallback(page, TARGET_URL);
		await preparePage(page);

		if (RECORD_MODE === "frames") {
			const frameCount = await recordFrames(page, framesDir);
			console.log(`   🧩 [${key.toUpperCase()}] frames captured: ${frameCount}`);
			await encodeFramesToVideo(framesDir, encodedPath);
		} else {
			const recorder = await page.screencast({ path: rawPath, fps: FPS });
			await wait(HERO_HOLD_MS);
			await autoScrollDown(page, SCROLL_DURATION_MS);
			await wait(END_HOLD_MS);
			await recorder.stop();
			await encodeVideo(rawPath, encodedPath);
		}
		const result = await validateVideo(encodedPath, vp);
		keepEncoded = true;

		console.log(
			`   ✅ [${key.toUpperCase()}] 検証成功: ` +
				`(${(result.bytes / 1024).toFixed(0)}KB / ${result.duration.toFixed(2)}秒 / ` +
				`${result.width}x${result.height} / ${result.codecName}/${result.pixFmt})`
		);
		return { ok: true, ...result, validatedPath: encodedPath, outPath };
	} catch (error) {
		console.log(`   ❌ [${key.toUpperCase()}] 録画失敗: ${error.message}`);
		return { ok: false, error: error.message };
	} finally {
		removeFileIfExists(rawPath);
		removeDirIfExists(framesDir);
		if (!keepEncoded) {
			removeFileIfExists(encodedPath);
		}
		await page.close().catch(() => {});
	}
}

// ---------------------------------------
// DB 書き戻し（既存スキーマを壊さない）
// ---------------------------------------
function writeBackDb({ pcOk, spOk }) {
	let db = {};
	if (fs.existsSync(DB_FILE)) {
		db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
	}

	const existingRecord = db[dbKey] || {};
	const existingMeta = existingRecord.meta || {};
	const existingAssets = existingRecord.assets || {};
	const existingVideo = existingAssets.video || { pc: null, sp: null };
	const existingAnalysis = existingRecord.analysis || {};

	const depth = urlObj.pathname.split("/").filter(Boolean).length;

	db[dbKey] = {
		...existingRecord,
		meta: {
			url: TARGET_URL,
			domain,
			slug,
			path: urlObj.pathname,
			depth,
			...existingMeta // 既存metaを優先保持。capturedAtは静止画側の値を尊重
		},
		assets: {
			...existingAssets,
			image: existingAssets.image || { pc: null, sp: null },
			thumb: existingAssets.thumb || { pc: null, sp: null },
			video: {
				...existingVideo,
				pc: pcOk ? pcUIPath : existingVideo.pc,
				sp: spOk ? spUIPath : existingVideo.sp
			}
		},
		analysis: {
			...existingAnalysis,
			// 録画済み動画が存在するページは、静止画だけでは情報が不足する
			// 動画対象として扱う。その他のanalysisフィールドはすべて保持する。
			needsVideo: true
		},
		tags: existingRecord.tags || []
	};

	fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
	console.log("💾 DB更新:", DB_FILE, `[${dbKey}]`);
	console.log("   assets.video.pc =", db[dbKey].assets.video.pc);
	console.log("   assets.video.sp =", db[dbKey].assets.video.sp);
}

// ---------------------------------------
// メイン
// ---------------------------------------
(async () => {
	// 録画前に既存DBを検索し、保存先・DBキー・相対パスを確定する。
	resolveTarget();
	console.log(`⚙️ 録画モード: ${RECORD_MODE} / 対象: ${ONLY_VIEWPORT}`);

	fs.mkdirSync(saveDir, { recursive: true });
	fs.mkdirSync(DB_DIR, { recursive: true });

	const puppeteer = await loadPuppeteer();
	const browser = await puppeteer.launch({
		headless: true,
		acceptInsecureCerts: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"]
	});

	let pcResult = { ok: false };
	let spResult = { ok: false };
	try {
		for (const key of selectedViewportKeys()) {
			if (key === "pc") pcResult = await recordViewport(browser, "pc");
			if (key === "sp") spResult = await recordViewport(browser, "sp");
		}
	} finally {
		await browser.close();
	}

	const pcOk = pcResult.ok === true;
	const spOk = spResult.ok === true;
	const okResults = [pcResult, spResult].filter(result => result.ok === true);
	if (okResults.length > 0) {
		try {
			installValidatedVideos(okResults);
			console.log("   ✅ 検証済み動画を出力ファイルへ置換");
			writeBackDb({ pcOk, spOk });
		} finally {
			removeFileIfExists(pcResult.validatedPath);
			removeFileIfExists(spResult.validatedPath);
		}
	} else {
		removeFileIfExists(pcResult.validatedPath);
		removeFileIfExists(spResult.validatedPath);
		console.log("⚠️ 指定対象が検証成功しなかったため、動画とDBは更新しません");
		process.exitCode = 1;
	}

	console.log("✅ 完了！");
})().catch(error => {
	console.error("❌ 録画処理に失敗:", error);
	process.exitCode = 1;
});
