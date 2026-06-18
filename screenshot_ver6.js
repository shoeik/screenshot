/**
 * ============================================================
 *  Webサイト全ページ 自動スクリーンショット取得ツール
 *  - sitelist.txt から複数サイトを自動撮影
 *  - --url=xxx で単体サイトのみ撮影（優先）
 *  - 深さ制限（0=無制限）
 *  - 1階層目でフォルダ分類
 *  - 2階層目以降のパスは slug としてファイル名に連結
 *  - TOP ページは "_top" 固定
 *  - LazyLoad 対策スクロール
 *  - 画像ロード待ち
 *  - Webフォント読み込み待ち
 *  - Cookieバナー自動閉じ
 *  - UA固定（SP/PC）
 * ============================================================
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ------------------------------------------
// ★深さ制限（0 = 無制限）
//   0：すべての階層を撮影
//   1：TOP + 第一階層まで
//   2：TOP + 第一階層 + 第二階層まで
// ------------------------------------------
const CRAWL_DEPTH = 0;

// ------------------------------------------
// 撮影デバイス設定
// ------------------------------------------
const viewports = [
  {
    width: 390,
    height: 844,
    label: 'sp',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
  },
  {
    width: 1440,
    height: 1024,
    label: 'pc',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
];

// ============================================================
//  Utility: コマンドライン引数から --url=xxx を取得
// ============================================================
function getUrlFromArgs() {
  const arg = process.argv.find(a => a.startsWith("--url="));
  if (!arg) return null;
  return arg.split("=")[1];
}

// ============================================================
//  Utility: sitelist.txt 読み込み（コメント行・空行は除外）
// ============================================================
function loadSiteList() {
  const file = path.join(__dirname, "sitelist.txt");
  if (!fs.existsSync(file)) {
    console.error("❌ sitelist.txt が見つかりません");
    process.exit(1);
  }

  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

// ============================================================
//  Utility: URLのパス深さを計算
// ============================================================
function getDepth(urlObj) {
  return urlObj.pathname.split("/").filter(Boolean).length;
}

// ============================================================
//  Utility: フォルダ作成
// ============================================================
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
//  Utility: パスから slug（2階層目以降を全連結）生成
//    C方式：service_web_seo_company-intro
//    depth = 0 → _top を返す
// ============================================================
function getSlug(urlObj) {
  const paths = urlObj.pathname.split("/").filter(Boolean);

  // TOP（/）は slug = "_top"
  if (paths.length === 0) return "_top";

  // 2階層目以降を連結（1階層目はフォルダになるため除外可）
  return paths.join("_");
}

// ============================================================
//  Utility: 第一階層フォルダ名の決定
//    depth = 0 → "_top"
//    depth = 1 → 第一階層のフォルダ名
//    depth >=2 → 第一階層のフォルダ名（2階層目以降はファイル名で区別）
// ============================================================
function getFirstFolder(urlObj) {
  const paths = urlObj.pathname.split("/").filter(Boolean);

  if (paths.length === 0) return "_top";   // TOP

  return paths[0]; // 第一階層をフォルダにする
}

// ============================================================
//  Utility: サイト内リンク抽出（同ドメイン + 不要拡張子除外）
// ============================================================
async function extractInternalLinks(page, origin) {
  return await page.$$eval('a[href]', (anchors, origin) => {
    return anchors
      .map(a => a.href)
      .filter(href =>
        href.startsWith(origin) &&
        !href.includes('#') &&
        !href.match(/\.(jpg|jpeg|png|gif|webp|pdf|css|js)$/i)
      );
  }, origin);
}

// ============================================================
//  Utility: Cookieバナー自動閉じ
// ============================================================
async function closeCookieBanner(page) {
  await page.evaluate(() => {
    const words = ["同意", "accept", "agree", "ok", "許可"];
    const btns = document.querySelectorAll("button, a");

    btns.forEach(b => {
      const text = b.innerText.toLowerCase().trim();
      if (words.some(w => text.includes(w))) {
        try { b.click(); } catch (e) {}
      }
    });
  });
}

// ============================================================
//  Utility: Webフォント読み込み待ち
// ============================================================
async function waitForFonts(page) {
  try {
    await page.evaluateHandle("document.fonts.ready");
  } catch (e) {
    console.log("⚠ フォント読み込み待ちでエラー:", e.message);
  }
}

// ============================================================
//  Utility: LazyLoad対策スクロール（300pxずつ）
// ============================================================
async function scrollForLazyLoad(page, maxTime = 8000, step = 300) {
  await page.evaluate((maxTime, step) => {
    return new Promise(resolve => {
      const start = Date.now();

      const timer = setInterval(() => {
        window.scrollBy(0, step);

        if (Date.now() - start > maxTime) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }, maxTime, step);
}

// ============================================================
//  Utility: 画像ロード最大5秒待ち
// ============================================================
async function waitForImages(page, timeout = 5000) {
  await page.evaluate((timeout) => {
    const images = Array.from(document.images);

    return Promise.race([
      Promise.allSettled(
        images.map(img =>
          img.complete
            ? Promise.resolve()
            : new Promise(resolve => {
                img.onload = img.onerror = resolve;
                setTimeout(resolve, timeout);
              })
        )
      ),
      new Promise(resolve => setTimeout(resolve, timeout))
    ]);
  }, timeout);
}

// ============================================================
//  Utility: 1ページを撮影
// ============================================================
async function capturePage(pageLink, browser, outputDir, vp, slug) {
  const p = await browser.newPage();

  try {
    await p.setUserAgent(vp.ua);
    await p.setViewport({ width: vp.width, height: vp.height });

    await p.goto(pageLink, { waitUntil: 'networkidle2' });

    await closeCookieBanner(p);
    await waitForFonts(p);
    await scrollForLazyLoad(p);
    await waitForImages(p);

    const fileName = `${slug}_${vp.label}.webp`;
    await p.screenshot({ path: path.join(outputDir, fileName), fullPage: true });

    console.log(`  ✅ Saved: ${outputDir}/${fileName}`);

  } catch (err) {
    console.error(`  ❌ Error on ${pageLink} (${vp.label}):`, err.message);
  } finally {
    await p.close();
  }
}

// ============================================================
//  サイト全ページ撮影ロジック
// ============================================================
async function processSite(TARGET_URL, browser) {
  console.log(`\n📷 Start: ${TARGET_URL}`);

  const page = await browser.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  const origin = new URL(TARGET_URL).origin;
  const links = await extractInternalLinks(page, origin);

  await page.close();

  const uniqueLinks = Array.from(new Set([TARGET_URL, ...links]));

  for (const link of uniqueLinks) {
    const urlObj = new URL(link);

    // 深さ制限
    const depth = getDepth(urlObj);
    if (CRAWL_DEPTH > 0 && depth > CRAWL_DEPTH) {
      console.log(`  ⏭ Skip (depth ${depth} > limit ${CRAWL_DEPTH}): ${link}`);
      continue;
    }

    const domain = urlObj.hostname;
    const folder = getFirstFolder(urlObj);
    const slug = getSlug(urlObj);

    const outputDir = path.join(__dirname, "screenshots", domain, folder);
    ensureDir(outputDir);

    for (const vp of viewports) {
      await capturePage(link, browser, outputDir, vp, slug);
    }
  }
}

// ============================================================
//  実行開始
// ============================================================
(async () => {
  const browser = await puppeteer.launch();
  const urlFromCLI = getUrlFromArgs();

  if (urlFromCLI) {
    // --url= が指定された場合 → その1サイトのみ実行
    await processSite(urlFromCLI, browser);
  } else {
    // リストから複数サイト実行
    const siteList = loadSiteList();
    for (const site of siteList) {
      await processSite(site, browser);
    }
  }

  await browser.close();
})();
