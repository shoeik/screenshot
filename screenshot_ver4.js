const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

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

(async () => {
  const url = 'https://mmslaw.jp/'; // ←撮影対象のURL
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // --- ① TOPページのリンク収集 ---
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const pageLinks = await page.$$eval('a[href]', anchors => {
    const origin = window.location.origin;

    return anchors
      .map(a => a.href)
      .filter(href =>
        href.startsWith(origin) &&
        !href.includes('#') &&
        !href.match(/\.(jpg|jpeg|png|gif|pdf|css|js)$/i)
      );
  });

  const uniqueLinks = Array.from(new Set([url, ...pageLinks])); // TOPも含む

  for (const pageLink of uniqueLinks) {
    const urlObj = new URL(pageLink);
    const domain = urlObj.hostname;

    // --- ② slug生成（ページ名） ---
    let slug = urlObj.pathname.replace(/\/$/, "");

    if (slug === "") {
      slug = "top";
    } else {
      const parts = slug.split("/").filter(Boolean);
      slug = parts.pop() || "top";
    }

    // --- ③ 保存先ディレクトリ ---
    const outputDir = path.join(__dirname, "screenshots", domain, slug);
    fs.mkdirSync(outputDir, { recursive: true });

    // --- ④ 各デバイスでスクショ ---
    for (const vp of viewports) {
      const p = await browser.newPage();

      try {
        // UA固定
        await p.setUserAgent(vp.ua);

        // ビューポート指定
        await p.setViewport({ width: vp.width, height: vp.height });

        // ページ遷移
        await p.goto(pageLink, { waitUntil: 'networkidle2' });

        // --- ④-1 Cookieバナーの簡易閉じ処理 ---
        await p.evaluate(() => {
          const keywords = ["同意", "accept", "agree"];
          const buttons = Array.from(document.querySelectorAll("button, a"));

          buttons.forEach(btn => {
            if (keywords.some(k => btn.innerText.toLowerCase().includes(k))) {
              try { btn.click(); } catch(e){}
            }
          });
        });

        // --- ④-2 フォント読み込み完了待ち ---
        try {
          await p.evaluateHandle("document.fonts.ready");
        } catch (e) {
          console.log("⚠ フォント読み込み待ちでエラー（無視）:", e.message);
        }

        // --- ④-3 LazyLoad対策（スクロール） ---
        await p.evaluate(() => {
          return new Promise(resolve => {
            let totalHeight = 0;
            // const distance = 120;
			const distance = 300;
            const maxTime = 8000;
            const start = Date.now();

            const timer = setInterval(() => {
              window.scrollBy(0, distance);
              totalHeight += distance;

              if (Date.now() - start > maxTime) {
                clearInterval(timer);
                resolve();
              }
            }, 100);
          });
        });

        // --- ④-4 画像ロードの最大5秒待ち ---
        await p.evaluate(() => {
          const images = Array.from(document.images);

          return Promise.race([
            Promise.allSettled(
              images.map(img =>
                img.complete
                  ? Promise.resolve()
                  : new Promise(resolve => {
                      img.onload = img.onerror = resolve;
                      setTimeout(resolve, 5000);
                    })
              )
            ),
            new Promise(resolve => setTimeout(resolve, 5000))
          ]);
        });

        // --- ⑤ スクショ保存 ---
        const fileName = `${vp.label}.webp`;
        const filePath = path.join(outputDir, fileName);

        await p.screenshot({ path: filePath, fullPage: true });

        console.log(`✅ Saved: ${filePath}`);

      } catch (err) {
        console.error(`❌ Error on ${pageLink} (${vp.label}):`, err.message);
      } finally {
        await p.close();
      }
    }
  }

  await browser.close();
})();
