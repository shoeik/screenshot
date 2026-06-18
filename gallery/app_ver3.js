
// localStorage に検索キーワード タグ　を保存する機能を追加
// localStorage にスクロール位置を保存・復元する機能を追加
// タグ選択UIを追加（左クリック＝AND、右クリック＝OR）


let data = [];      // 配列化した一覧
let filtered = [];  // 今後フィルタ用に残しておく
// let selectedTags = [];
let selectedTagsAND = [];
let selectedTagsOR  = [];

const gallery = document.getElementById("gallery");
const categorySelect = document.getElementById("filter-category");
const industrySelect = document.getElementById("filter-industry");
const tagArea = document.getElementById("tag-area");
const selectedTagsWrap = document.getElementById("selected-tags");



// ======================================
// ローカルストレージ：検索キーワード復元
// ======================================
function restoreSearch() {
	const saved = localStorage.getItem("search_keyword");
	if (saved) {
		searchInput.value = saved;
	}
}

// ======================================
// ローカルストレージ：タグ保存
// ======================================
// function saveSelectedTags() {
// 	localStorage.setItem("selectedTagsAND", JSON.stringify(selectedTagsAND));
// 	localStorage.setItem("selectedTagsOR",  JSON.stringify(selectedTagsOR));
// }

function saveTagState() {
	localStorage.setItem("selectedTagsAND", JSON.stringify(selectedTagsAND));
	localStorage.setItem("selectedTagsOR", JSON.stringify(selectedTagsOR));
}

// ======================================
// ローカルストレージ：タグ復元
// ======================================
function restoreSelectedTags() {
	// ANDとORだけ復元すれば良い
	selectedTagsAND = JSON.parse(localStorage.getItem("selectedTagsAND") || "[]");
	selectedTagsOR  = JSON.parse(localStorage.getItem("selectedTagsOR")  || "[]");
}


// 初期化
(async function init() {
	try {
		// 1. JSONを読み込み
		const raw = await fetch("../screenshots.json").then(res => res.json());

		// console.log("✅ raw JSON:", raw);

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

		// console.log("✅ normalized data:", data);


		// 3. いったん全件をベースにする
		filtered = data;

		// ★ 保存していた検索キーワード・タグを復元
		restoreSearch();
		restoreSelectedTags();

		// ★ 復元された selectedTags を使ってタグUIを生成
		setupTagArea();
		renderSelectedTags();
		
		// ★ 最後に「現在の状態（検索・タグ）でフィルタをかけて描画」
		applyFilters();


		setTimeout(() => {
			const savedY = localStorage.getItem("gallery_scrollY");
			if (savedY) {
				window.scrollTo(0, Number(savedY));
			}
		}, 100);

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
		// console.log("🖼 render item:", item.fileName, "→", item.path);

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

	// data 内のすべてのタグを一意に抽出
	const tags = [...new Set(data.flatMap(d => d.tags))];

	tags.forEach(t => {
		const span = document.createElement("span");
		span.classList.add("tag");

		// 見た目反映
		if (selectedTagsAND.includes(t)) span.classList.add("tag-and");
		else if (selectedTagsOR.includes(t)) span.classList.add("tag-or");
		else span.classList.add("tag-off");

		span.textContent = t;

		// ---- 左クリック＝AND ----
		span.onclick = () => {
			if (selectedTagsAND.includes(t)) {
				selectedTagsAND = selectedTagsAND.filter(x => x !== t);
			} else {
				// AND に追加 → OR に入ってたら除外
				selectedTagsAND.push(t);
				selectedTagsOR = selectedTagsOR.filter(x => x !== t);
			}

			saveTagState();
			applyFilters();
			setupTagArea();
			renderSelectedTags();
		};

		// ---- 右クリック＝OR ----
		span.oncontextmenu = (e) => {
			e.preventDefault();

			if (selectedTagsOR.includes(t)) {
				selectedTagsOR = selectedTagsOR.filter(x => x !== t);
			} else {
				// OR に追加 → AND にあれば除外
				selectedTagsOR.push(t);
				selectedTagsAND = selectedTagsAND.filter(x => x !== t);
			}

			saveTagState();
			applyFilters();
			setupTagArea();
			renderSelectedTags();
		};

		tagArea.appendChild(span);
	});
}


// 選択中タグの表示
function renderSelectedTags() {
	const wrap = document.getElementById("selected-tags");
	wrap.innerHTML = "";

	// ANDタグ
	selectedTagsAND.forEach(t => {
		const div = document.createElement("div");
		div.className = "selected-tag tag-and";
		div.innerHTML = `${t} <span class="close">×</span>`;
		div.querySelector(".close").onclick = () => {
			selectedTagsAND = selectedTagsAND.filter(x => x !== t);
			saveTagState();
			applyFilters();
			setupTagArea();
			renderSelectedTags();
		};
		wrap.appendChild(div);
	});

	// ORタグ
	selectedTagsOR.forEach(t => {
		const div = document.createElement("div");
		div.className = "selected-tag tag-or";
		div.innerHTML = `${t} <span class="close">×</span>`;
		div.querySelector(".close").onclick = () => {
			selectedTagsOR = selectedTagsOR.filter(x => x !== t);
			saveTagState();
			applyFilters();
			setupTagArea();
			renderSelectedTags();
		};
		wrap.appendChild(div);
	});
}




const searchInput = document.getElementById("search");

// 文字入力時にフィルタ
searchInput.oninput = applyFilters;

searchInput.addEventListener("input", () => {
	localStorage.setItem("search_keyword", searchInput.value);
});


function applyFilters() {
	let result = [...data];

	// ---- キーワード検索 ----
	const keyword = searchInput.value.trim().toLowerCase();
	if (keyword) {
		result = result.filter(d =>
			(d.slug && d.slug.toLowerCase().includes(keyword)) ||
			(d.domain && d.domain.toLowerCase().includes(keyword)) ||
			(d.url && d.url.toLowerCase().includes(keyword)) ||
			(d.viewport && d.viewport.toLowerCase().includes(keyword))
		);
	}

	// ---- タグフィルタ（AND / OR） ----
	if (selectedTagsAND.length > 0 || selectedTagsOR.length > 0) {

		result = result.filter(item => {

			// AND: 全部含む
			const matchAND = selectedTagsAND.every(t => item.tags.includes(t));

			// OR: 1個でも含めばOK（ORが0なら無条件true）
			const matchOR = selectedTagsOR.length === 0
				? true
				: selectedTagsOR.some(t => item.tags.includes(t));

			return matchAND && matchOR;
		});
	}

	filtered = result;

	// ---- タグ一覧は初回だけ描画。選択タグUIだけ更新 ----
	renderSelectedTags();
	renderGallery();
}

// ======================================
// スクロール位置の保存
// ======================================
window.addEventListener("scroll", () => {
	localStorage.setItem("gallery_scrollY", window.scrollY);
});