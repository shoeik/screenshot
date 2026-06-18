
// 
// 深さ制限 追加
// 


const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ------------------------------------------
// 設定 → 深さ制限（0 = 無制限）
const CRAWL_DEPTH = 0;   // ← 好きな深さに変更（0,1,2 など）
// ------------------------------------------

// デバイス設定
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

// 撮影対象URL
const TARGET_URL = "https://solvvy.co.jp/";


// ------------------------------------------
// Utility: 深さを計算
// ------------------------------------------
function getDepth(urlObj) {
  const paths = urlObj.pathname.split("/").filter(Boolean);
  return paths.length; // "" → 深さ0
}


// ------------------------------------------
// Utility: ディレクトリ作成
// ------------------------------------------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}


// ------------------------------------------
// Utility: slug生成
// ------------------------------------------
function getSlug(urlObj) {
  let slug = urlObj.pathname.replace(/\/$/, "");

  if (slug === "") return "top";

  const parts = slug.split("/").filter(Boolean);
  return parts.pop() || "top";
}


// ------------------------------------------
// Utility: 内部リンク抽出
// ------------------------------------------
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


// ------------------------------------------
// Utility: Cookieバナー閉じ
// ------------------------------------------
async function closeCookieBanner(page) {
  await page.evaluate(() => {
    const words = ["同意", "accept", "agree", "ok"];
    const btns = document.querySelectorAll("button, a");

    btns.forEach(b => {
      const text = b.innerText.toLowerCase().trim();
      if (words.some(w => text.includes(w))) {
        try { b.click(); } catch (e) {}
      }
    });
  });
}


// ------------------------------------------
// Utility: Webフォント読み込み待ち
// ------------------------------------------
async function waitForFonts(page) {
  try {
    await page.evaluateHandle("document.fonts.ready");
  } catch (e) {
    console.log("⚠ フォント読み込み待ちでエラー:", e.message);
  }
}


// ------------------------------------------
// Utility: LazyLoad対策スクロール（300px）
// ------------------------------------------
async function scrollForLazyLoad(page, maxTime = 8000, step = 300) {

  await page.evaluate((maxTime, step) => {
    return new Promise(resolve => {
      let totalHeight = 0;
      const start = Date.now();

      const timer = setInterval(() => {
        window.scrollBy(0, step);
        totalHeight += step;

        if (Date.now() - start > maxTime) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }, maxTime, step);
}


// ------------------------------------------
// Utility: 画像ロード最大5秒待ち
// ------------------------------------------
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


// ------------------------------------------
// 1ページを撮影
// ------------------------------------------
async function capturePage(pageLink, browser, outputDir, vp) {
  const p = await browser.newPage();

  try {
    await p.setUserAgent(vp.ua);
    await p.setViewport({ width: vp.width, height: vp.height });

    await p.goto(pageLink, { waitUntil: 'networkidle2' });

    await closeCookieBanner(p);
    await waitForFonts(p);
    await scrollForLazyLoad(p, 8000, 300);
    await waitForImages(p, 5000);

    const fileName = `${vp.label}.webp`;
    await p.screenshot({ path: path.join(outputDir, fileName), fullPage: true });

    console.log(`✅ Saved: ${outputDir}/${fileName}`);

  } catch (err) {
    console.error(`❌ Error on ${pageLink} (${vp.label}):`, err.message);
  } finally {
    await p.close();
  }
}


// ------------------------------------------
// メイン処理
// ------------------------------------------
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // 内部リンク取得
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  const origin = new URL(TARGET_URL).origin;

  const links = await extractInternalLinks(page, origin);
  const uniqueLinks = Array.from(new Set([TARGET_URL, ...links]));

  // 各ページを処理
  for (const link of uniqueLinks) {
    const urlObj = new URL(link);

    // 深さ制限チェック
    const depth = getDepth(urlObj);
    if (CRAWL_DEPTH > 0 && depth > CRAWL_DEPTH) {
      console.log(`⏭ Skip (depth ${depth} > limit ${CRAWL_DEPTH}): ${link}`);
      continue;
    }

    const domain = urlObj.hostname;
    const slug = getSlug(urlObj);

    const outputDir = path.join(__dirname, "screenshots", domain, slug);
    ensureDir(outputDir);

    for (const vp of viewports) {
      await capturePage(link, browser, outputDir, vp);
    }
  }

  await browser.close();
})();
