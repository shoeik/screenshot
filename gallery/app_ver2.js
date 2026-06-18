
// 機能盛り込み版を作ろうとして、キリがなくなって
// とりあえず最小限で動くものを作ることにした版


let data = [];      // 配列化した一覧
let filtered = [];  // 今後フィルタ用に残しておく

const gallery = document.getElementById("gallery");



let selectedTags = [];

const tagArea = document.getElementById("tag-area");
const selectedTagsWrap = document.getElementById("selected-tags");




// 初期化
(async function init() {
	try {
		// 1. JSONを読み込み
		const raw = await fetch("../screenshots.json").then(res => res.json());

		console.log("✅ raw JSON:", raw);

		// 2. { fileName: {...}, ... } → [{ fileName, ... }, ...] に変換
		data = Object.entries(raw).map(([fileName, info]) => {
			return {
				fileName,
				url: info.url,
				domain: info.domain,
				folder: info.folder,
				slug: info.slug,
				viewport: info.viewport,
				path: info.path,
				// タイトル代わりに slug を使う（暫定）
				title: info.slug || fileName,
				// タグはまだ無いので空配列（後で付与）
				tags: info.tags || []
			};
		});

		console.log("✅ normalized data:", data);

		// 3. 今は filtered = data そのまま
		// 3. ★ ダミータグの注入（テスト用）
		// data = data.map(item => {
		// 	return {
		// 	...item,
		// 	tags: ["dummy", item.folder, item.viewport]
		// 	};
		// });

		// console.log("data with dummy tags:", data);

		filtered = data;



		setupTagArea();
		renderSelectedTags();
		// 4. ギャラリー描画
		renderGallery();

	} catch (e) {
		console.error("❌ JSON読み込み/パース中にエラー:", e);
	}
})();

// ギャラリー描画（最小版）
function renderGallery() {
  gallery.innerHTML = "";

  if (!filtered || filtered.length === 0) {
    gallery.innerHTML = "<p>データがありません。</p>";
    return;
  }

  filtered.forEach(item => {
    const div = document.createElement("div");
    div.className = "item";

    // path が相対パスかどうか確認するためログ
    console.log("🖼 render item:", item.fileName, "→", item.path);

    div.innerHTML = `
      <a href="${item.url}" target="_blank" rel="noopener noreferrer">
        <img src="${item.path}" alt="${item.title}" loading="lazy">
      </a>
      <div class="title">${item.title}</div>
      <div class="url">${item.url}</div>
    `;

    gallery.appendChild(div);
  });
}


// タグ一覧の描画
function setupTagArea() {
  tagArea.innerHTML = "";

  // 全タグを unique に抽出
  const allTags = [...new Set(data.flatMap(d => d.tags || []))];

  allTags.forEach(tag => {
    const span = document.createElement("span");
    span.classList.add("tag");
    if (selectedTags.includes(tag)) span.classList.add("active");

    span.textContent = tag;

    span.onclick = () => {
      if (selectedTags.includes(tag)) {
        // タグ解除
        selectedTags = selectedTags.filter(t => t !== tag);
      } else {
        // タグ追加
        selectedTags.push(tag);
      }

      applyFilters();
      setupTagArea();      // 再描画
      renderSelectedTags();
    };

    tagArea.appendChild(span);
  });
}


// 選択中タグの表示
function renderSelectedTags() {
  selectedTagsWrap.innerHTML = "";

  selectedTags.forEach(tag => {
    const div = document.createElement("div");
    div.classList.add("selected-tag");

    div.innerHTML = `
      ${tag}
      <span class="close">×</span>
    `;

    // ×クリックで解除
    div.querySelector(".close").onclick = () => {
      selectedTags = selectedTags.filter(t => t !== tag);
      applyFilters();
      setupTagArea();
      renderSelectedTags();
    };

    selectedTagsWrap.appendChild(div);
  });
}




const searchInput = document.getElementById("search");

// 文字入力時にフィルタ
searchInput.oninput = applyFilters;

function applyFilters() {
  let result = [...data];  // 元データをコピー

  const keyword = searchInput.value.trim().toLowerCase();

  if (keyword) {
    result = result.filter(d =>
      (d.slug && d.slug.toLowerCase().includes(keyword)) ||
      (d.domain && d.domain.toLowerCase().includes(keyword)) ||
      (d.url && d.url.toLowerCase().includes(keyword)) ||
	  (d.viewport && d.viewport.toLowerCase().includes(keyword))
    );
  }

  	// タグ AND 条件フィルタ
	if (selectedTags.length > 0) {
		result = result.filter(d =>
			selectedTags.every(tag => (d.tags || []).includes(tag))
		);
	}


	filtered = result;
	setupTagArea();
	renderSelectedTags();
	renderGallery();
}
