const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const viewports = [
  { width: 390, height: 844, label: 'sp' },
  { width: 1440, height: 1024, label: 'pc' }
];

(async () => {
  const url = 'https://mmslaw.jp/';
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // --- ① TOPページを開き、同ドメインの下層ページを抽出 ---
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const pageLinks = await page.$$eval('a[href]', anchors => {
    const origin = window.location.origin;

    return anchors
      .map(a => a.href)
      .filter(href =>
        href.startsWith(origin) &&
        !href.includes('#') &&
        !href.match(/\.(jpg|png|pdf|css|js)$/i)
      );
  });

  // TOPページも追加して重複を削除
  const uniqueLinks = Array.from(new Set([url, ...pageLinks]));

  for (const pageLink of uniqueLinks) {
    const urlObj = new URL(pageLink);

    // --- ② ドメイン名（例：solvvy.co.jp） ---
    const domain = urlObj.hostname;

    // --- ③ slug（ページ名）をURLパスから抽出 ---
    // / → top
    // /service/ → service
    // /recruit/index → recruit
    let slug = urlObj.pathname.replace(/\/$/, ""); // 末尾スラッシュ除去

    if (slug === "") {
      slug = "top";
    } else {
      const parts = slug.split("/").filter(Boolean);
      slug = parts.pop() || "top";
    }

    // --- ④ 保存ディレクトリを作成 ---
    const outputDir = path.join(__dirname, "screenshots", domain, slug);
    fs.mkdirSync(outputDir, { recursive: true });

    const page = await browser.newPage();

    for (const vp of viewports) {
		try {
			await page.setViewport({ width: vp.width, height: vp.height });
			await page.goto(pageLink, { waitUntil: 'networkidle2' });

			// --- LazyLoad対策：下へスクロール ---
			await page.evaluate(() => {
				return new Promise(resolve => {
					let totalHeight = 0;
					const distance = 100;
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

			// --- 画像のロード完了待ち ---
			await page.evaluate(async () => {
				const delay = (ms) => new Promise(res => setTimeout(res, ms));

				const scrollStep = 300;  // 300pxずつ早く下る
				let totalScrolled = 0;

				const maxScroll = document.body.scrollHeight;
				const maxTime = 8000;
				const start = Date.now();

				while (totalScrolled < maxScroll) {
					window.scrollBy(0, scrollStep);
					totalScrolled += scrollStep;

					await delay(200);

					// 全画像読み込みチェック
					const allLoaded = Array.from(document.images).every(img => img.complete);
					if (allLoaded) break;

					// 最大時間を超えたら終了
					if (Date.now() - start > maxTime) break;
				}
			});


			// --- ⑤ デバイス名だけのシンプル命名 ---
			const fileName = `${vp.label}.webp`;
			const filePath = path.join(outputDir, fileName);

			await page.screenshot({ path: filePath, fullPage: true });

			console.log(`✅ Saved: ${filePath}`);

		} catch (e) {
			console.error(`❌ Error on ${pageLink} at ${vp.label}:`, e.message);
		}
    }

    await page.close();
  }

  await browser.close();
})();
