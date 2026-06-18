const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const viewports = [
  { width: 390, height: 844, label: 'sp', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1' },
  { width: 1440, height: 1024, label: 'pc', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
];

(async () => {
  const url = 'https://mmslaw.jp/'; // ★ここは撮りたいサイトごとに変える
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // --- TOPページを開いて同ドメインの下層リンクだけ抽出 ---
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const pageLinks = await page.$$eval('a[href]', anchors => {
    const origin = window.location.origin;

    return anchors
      .map(a => a.href)
      .filter(href =>
        href.startsWith(origin) &&
        !href.includes('#') &&
        !href.match(/\.(jpg|jpeg|png|gif|webp|pdf|css|js)$/i)
      );
  });

  // TOPページも含めて重複削除
  const uniqueLinks = Array.from(new Set([url, ...pageLinks]));

  for (const pageLink of uniqueLinks) {
    const urlObj = new URL(pageLink);
    const domain = urlObj.hostname;

    // --- slug（ページ名） ---
    // / → top
    // /service/ → service
    // /recruit/index → recruit
    let slug = urlObj.pathname.replace(/\/$/, ""); // 末尾 / を除去
    if (slug === "") {
      slug = "top";
    } else {
      const parts = slug.split("/").filter(Boolean);
      slug = parts.pop() || "top";
    }

    // 保存ディレクトリ
    const outputDir = path.join(__dirname, "screenshots", domain, slug);
    fs.mkdirSync(outputDir, { recursive: true });

    // 各 viewport ごとに撮影
    for (const vp of viewports) {
      const p = await browser.newPage();
      try {
        // UA + viewport を設定
        await p.setUserAgent(vp.ua);
        await p.setViewport({ width: vp.width, height: vp.height });

        // ページ遷移（できるだけ落ち着いた状態まで待つ）
        await p.goto(pageLink, { waitUntil: 'networkidle2' });

        // ① スクロールバー非表示（見た目をきれいに）
        await p.addStyleTag({
          content: `
            ::-webkit-scrollbar {
              display: none !important;
            }
          `
        });

        // // ② アニメーション停止（安定した状態で撮る）
        // await p.addStyleTag({
        //   content: `
        //     * {
        //       animation: none !important;
        //       transition: none !important;
        //     }
        //   `
        // });

        // ③ Webフォントのロード完了を待つ（品質向上）
        try {
          await p.evaluateHandle('document.fonts.ready');
        } catch (e) {
          console.warn('⚠ フォント待機でエラー（無視して続行）:', e.message);
        }

        // ④ LazyLoad最適化：下へスクロールしながら画像を読み込ませる
        await p.evaluate(async () => {
          const delay = (ms) => new Promise(res => setTimeout(res, ms));

          const scrollStep = 300;
          const maxTime = 8000;
          let totalScrolled = 0;
          const start = Date.now();

          const getScrollHeight = () =>
            Math.max(
              document.body.scrollHeight,
              document.documentElement.scrollHeight
            );

          let maxScroll = getScrollHeight();

          while (true) {
            window.scrollBy(0, scrollStep);
            totalScrolled += scrollStep;

            await delay(200);

            const allLoaded = Array.from(document.images).every(img => img.complete);
            if (allLoaded) break;

            maxScroll = getScrollHeight();
            const reachedBottom =
              (window.innerHeight + window.scrollY + 10) >= maxScroll;

            if (reachedBottom) break;

            if (Date.now() - start > maxTime) break;
          }

          window.scrollTo(0, 0);
        });

        // ⑤ 画像のロード完了を「最大5秒まで」待つ
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

        // ⑥ スクショ保存（device名だけのシンプル命名）
        const fileName = `${vp.label}.webp`;
        const filePath = path.join(outputDir, fileName);

        await p.screenshot({ path: filePath, fullPage: true });
        console.log(`✅ Saved: ${filePath}`);
      } catch (e) {
        console.error(`❌ Error on ${pageLink} at ${vp.label}:`, e.message);
      } finally {
        await p.close();
      }
    }
  }

  await browser.close();
})();
