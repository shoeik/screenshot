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
 *
 * 保存先（既存構造に合わせる）:
 *   screenshots/<domain>/top/<domain>_top_pc.mp4
 *   screenshots/<domain>/top/<domain>_top_sp.mp4
 *
 * DB 書き戻し（既存値は壊さない）:
 *   screenshots_db/<domain>.json の対象URLキーに
 *   assets.video.pc / assets.video.sp（gallery相対パス）を追記。
 *   assets.image / assets.thumb / tags / _site.tags / analysis は保持。
 *   analysis.needsVideo = true。
 *
 * 依存:
 *   page.screencast()（Puppeteer ネイティブ）+ ffmpeg。
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
const TARGET_URL = process.argv[2];
if (!TARGET_URL) {
	console.error("❌ URL を指定してください");
	console.error("   例: node record_top.js https://hikarina.co.jp/");
	process.exit(1);
}

let urlObj;
try {
	urlObj = new URL(TARGET_URL);
} catch {
	console.error("❌ URL が不正です:", TARGET_URL);
	process.exit(1);
}

const domain = urlObj.hostname.replace(/\./g, "_");
const slug = "top";
const saveDir = path.join("screenshots", domain, slug);
const baseName = `${domain}_${slug}`;
const pcFsPath = path.join(saveDir, `${baseName}_pc.mp4`);
const spFsPath = path.join(saveDir, `${baseName}_sp.mp4`);
const pcUIPath = `../${pcFsPath.replace(/\\/g, "/")}`;
const spUIPath = `../${spFsPath.replace(/\\/g, "/")}`;
const DB_FILE = `./screenshots_db/${domain}.json`;
const TEMP_SUFFIX = `${process.pid}-${Date.now()}`;

// ---------------------------------------
// ユーティリティ
// ---------------------------------------
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
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

function parseDurationSeconds(value) {
	const match = String(value).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
	if (!match) return null;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function remuxVideo(inputPath, outputPath) {
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
			"-c",
			"copy",
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
	const dimensionsMatch = videoStreamLine?.match(/,\s*(\d{2,5})x(\d{2,5})(?:[,\s])/);
	const width = dimensionsMatch ? Number(dimensionsMatch[1]) : null;
	const height = dimensionsMatch ? Number(dimensionsMatch[2]) : null;
	if (width !== expectedViewport.width || height !== expectedViewport.height) {
		throw new Error(
			`解像度が不正です: ${width || "?"}x${height || "?"} ` +
				`(期待値 ${expectedViewport.width}x${expectedViewport.height})`
		);
	}

	return { bytes, duration, width, height };
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

async function recordViewport(browser, key) {
	const vp = VIEWPORTS[key];
	const outPath = key === "pc" ? pcFsPath : spFsPath;
	const rawPath = path.join(saveDir, `.${baseName}_${key}.${TEMP_SUFFIX}.raw.mp4`);
	const remuxedPath = path.join(saveDir, `.${baseName}_${key}.${TEMP_SUFFIX}.remux.mp4`);
	let keepRemuxed = false;

	const page = await browser.newPage();
	try {
		await page.setUserAgent(vp.userAgent);
		await page.setViewport({ width: vp.width, height: vp.height });

		console.log(`🎬 [${key.toUpperCase()}] 録画準備: ${TARGET_URL}`);
		await gotoWithFallback(page, TARGET_URL);
		await preparePage(page);

		const recorder = await page.screencast({ path: rawPath, fps: FPS });
		await wait(HERO_HOLD_MS);
		await autoScrollDown(page, SCROLL_DURATION_MS);
		await wait(END_HOLD_MS);
		await recorder.stop();

		await remuxVideo(rawPath, remuxedPath);
		const result = await validateVideo(remuxedPath, vp);
		keepRemuxed = true;

		console.log(
			`   ✅ [${key.toUpperCase()}] 検証成功: ` +
				`(${(result.bytes / 1024).toFixed(0)}KB / ${result.duration.toFixed(2)}秒 / ` +
				`${result.width}x${result.height})`
		);
		return { ok: true, ...result, validatedPath: remuxedPath, outPath };
	} catch (error) {
		console.log(`   ❌ [${key.toUpperCase()}] 録画失敗: ${error.message}`);
		return { ok: false, error: error.message };
	} finally {
		removeFileIfExists(rawPath);
		if (!keepRemuxed) {
			removeFileIfExists(remuxedPath);
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

	const existingRecord = db[TARGET_URL] || {};
	const existingMeta = existingRecord.meta || {};
	const existingAssets = existingRecord.assets || {};
	const existingVideo = existingAssets.video || { pc: null, sp: null };
	const existingAnalysis = existingRecord.analysis || {};

	const depth = urlObj.pathname.split("/").filter(Boolean).length;

	db[TARGET_URL] = {
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
	console.log("💾 DB更新:", DB_FILE);
	console.log("   assets.video.pc =", db[TARGET_URL].assets.video.pc);
	console.log("   assets.video.sp =", db[TARGET_URL].assets.video.sp);
}

// ---------------------------------------
// メイン
// ---------------------------------------
(async () => {
	fs.mkdirSync(saveDir, { recursive: true });
	fs.mkdirSync("./screenshots_db", { recursive: true });

	const puppeteer = await loadPuppeteer();
	const browser = await puppeteer.launch({
		headless: true,
		acceptInsecureCerts: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"]
	});

	let pcResult = { ok: false };
	let spResult = { ok: false };
	try {
		pcResult = await recordViewport(browser, "pc");
		spResult = await recordViewport(browser, "sp");
	} finally {
		await browser.close();
	}

	const pcOk = pcResult.ok === true;
	const spOk = spResult.ok === true;
	if (pcOk && spOk) {
		try {
			installValidatedVideos([pcResult, spResult]);
			console.log("   ✅ PC/SP動画を検証済みファイルへ置換");
			writeBackDb({ pcOk, spOk });
		} finally {
			removeFileIfExists(pcResult.validatedPath);
			removeFileIfExists(spResult.validatedPath);
		}
	} else {
		removeFileIfExists(pcResult.validatedPath);
		removeFileIfExists(spResult.validatedPath);
		console.log("⚠️ PC/SPの両方が検証成功しなかったため、動画とDBは更新しません");
		process.exitCode = 1;
	}

	console.log("✅ 完了！");
})().catch(error => {
	console.error("❌ 録画処理に失敗:", error);
	process.exitCode = 1;
});
