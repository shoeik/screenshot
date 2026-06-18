// ver4からの変更点
// screenshot_batch.js対応版


let data = [];
let filtered = [];
let selectedTagsAND = [];
let selectedTagsOR  = [];
let editMode = true;

const gallery = document.getElementById("gallery");
const tagArea = document.getElementById("tag-area");
const selectedTagsWrap = document.getElementById("selected-tags");
const searchInput = document.getElementById("search");

// ======================================
// ローカルストレージ
// ======================================
function restoreSearch() {
	const saved = localStorage.getItem("search_keyword");
	if (saved) searchInput.value = saved;
}

function saveTagState() {
	localStorage.setItem("selectedTagsAND", JSON.stringify(selectedTagsAND));
	localStorage.setItem("selectedTagsOR", JSON.stringify(selectedTagsOR));
}

function restoreSelectedTags() {
	selectedTagsAND = JSON.parse(localStorage.getItem("selectedTagsAND") || "[]");
	selectedTagsOR  = JSON.parse(localStorage.getItem("selectedTagsOR")  || "[]");
}

// ======================================
// 初期化
// ======================================
(async function init() {
	try {
		const raw = await fetch("../screenshots_db/mmslaw_jp.json").then(r => r.json());

		// URLキー → 配列化（新スキーマ対応）
		data = Object.entries(raw).map(([url, info]) => ({
			url,
			meta: info.meta,
			assets: info.assets,
			analysis: info.analysis || {},
			tags: info.tags || [],
			title: info.meta.slug || url
		}));

		filtered = data;

		restoreSearch();
		restoreSelectedTags();

		setupTagArea();
		renderSelectedTags();
		applyFilters();

		const savedY = localStorage.getItem("gallery_scrollY");
		if (savedY) window.scrollTo(0, Number(savedY));

	} catch (e) {
		console.error("❌ JSON読み込みエラー:", e);
	}
})();

// ======================================
// ギャラリー描画
// ======================================
function renderGallery() {
	gallery.innerHTML = "";

	if (!filtered.length) {
		gallery.innerHTML = "<p>データがありません。</p>";
		return;
	}

	filtered.forEach(item => {
		const div = document.createElement("div");
		div.className = "item";

		const imgPC = item.assets?.image?.pc;
		const imgSP = item.assets?.image?.sp;

		div.innerHTML = `
			<a href="${item.url}" target="_blank" rel="noopener noreferrer">
				<div class="thumbs">
					${imgPC ? `<img src="${imgPC}" alt="PC ${item.title}" loading="lazy">` : ""}
					<!-- ${imgSP ? `<img src="${imgSP}" alt="SP ${item.title}" loading="lazy">` : ""} -->	
				</div>
				</a>
				

			<div class="title">${item.title}</div>
			<div class="url">${item.url}</div>

			${editMode ? `
				<div class="tag-editor">
					<div class="tag-list">
						${item.tags.map(tag => `
							<span class="tag-chip" data-tag="${tag}">
								<span class="name">${tag}</span>
								<span class="remove">×</span>
							</span>
						`).join("")}
						<span class="tag-add">+追加</span>
					</div>
				</div>
			` : ""}
		`;

		gallery.appendChild(div);

		if (!editMode) return;

		// タグ削除
		div.querySelectorAll(".tag-chip").forEach(chip => {
			const tag = chip.dataset.tag;

			chip.querySelector(".remove").onclick = e => {
				e.stopPropagation();
				item.tags = item.tags.filter(t => t !== tag);
				applyFilters();
			};

			chip.querySelector(".name").onclick = () => {
				if (!selectedTagsAND.includes(tag)) {
					selectedTagsAND.push(tag);
					selectedTagsOR = selectedTagsOR.filter(t => t !== tag);
				}
				saveTagState();
				applyFilters();
			};

			chip.querySelector(".name").oncontextmenu = e => {
				e.preventDefault();
				if (!selectedTagsOR.includes(tag)) {
					selectedTagsOR.push(tag);
					selectedTagsAND = selectedTagsAND.filter(t => t !== tag);
				}
				saveTagState();
				applyFilters();
			};
		});

		// タグ追加
		const addBtn = div.querySelector(".tag-add");
		addBtn.onclick = e => {
			e.stopPropagation();
			const newTag = prompt("追加するタグを入力");
			if (!newTag) return;
			item.tags = Array.from(new Set([...item.tags, newTag.trim()]));
			applyFilters();
		};
	});
}

// ======================================
// タグ一覧
// ======================================
function setupTagArea() {
	tagArea.innerHTML = "";
	const tags = [...new Set(data.flatMap(d => d.tags))];

	tags.forEach(tag => {
		const el = document.createElement("span");
		el.className = "tag";
		el.textContent = tag;

		if (selectedTagsAND.includes(tag)) el.classList.add("tag-and");
		else if (selectedTagsOR.includes(tag)) el.classList.add("tag-or");
		else el.classList.add("tag-off");

		el.onclick = () => {
			if (selectedTagsAND.includes(tag)) {
				selectedTagsAND = selectedTagsAND.filter(t => t !== tag);
			} else {
				selectedTagsAND.push(tag);
				selectedTagsOR = selectedTagsOR.filter(t => t !== tag);
			}
			saveTagState();
			applyFilters();
		};

		el.oncontextmenu = e => {
			e.preventDefault();
			if (selectedTagsOR.includes(tag)) {
				selectedTagsOR = selectedTagsOR.filter(t => t !== tag);
			} else {
				selectedTagsOR.push(tag);
				selectedTagsAND = selectedTagsAND.filter(t => t !== tag);
			}
			saveTagState();
			applyFilters();
		};

		tagArea.appendChild(el);
	});
}

// ======================================
// 選択中タグ表示
// ======================================
function renderSelectedTags() {
	selectedTagsWrap.innerHTML = "";

	[["tag-and", selectedTagsAND], ["tag-or", selectedTagsOR]].forEach(([cls, list]) => {
		list.forEach(tag => {
			const div = document.createElement("div");
			div.className = `selected-tag ${cls}`;
			div.innerHTML = `${tag} <span class="close">×</span>`;
			div.querySelector(".close").onclick = () => {
				if (cls === "tag-and") {
					selectedTagsAND = selectedTagsAND.filter(t => t !== tag);
				} else {
					selectedTagsOR = selectedTagsOR.filter(t => t !== tag);
				}
				saveTagState();
				applyFilters();
			};
			selectedTagsWrap.appendChild(div);
		});
	});
}

// ======================================
// フィルタ
// ======================================
searchInput.oninput = () => {
	localStorage.setItem("search_keyword", searchInput.value);
	applyFilters();
};

function applyFilters() {
	let result = [...data];

	const keyword = searchInput.value.trim().toLowerCase();
	if (keyword) {
		result = result.filter(d =>
			d.meta.slug.toLowerCase().includes(keyword) ||
			d.meta.domain.toLowerCase().includes(keyword) ||
			d.url.toLowerCase().includes(keyword)
		);
	}

	if (selectedTagsAND.length || selectedTagsOR.length) {
		result = result.filter(item => {
			const andOK = selectedTagsAND.every(t => item.tags.includes(t));
			const orOK  = selectedTagsOR.length === 0 || selectedTagsOR.some(t => item.tags.includes(t));
			return andOK && orOK;
		});
	}

	filtered = result;
	renderSelectedTags();
	renderGallery();
}

// ======================================
// スクロール位置保存
// ======================================
window.addEventListener("scroll", () => {
	localStorage.setItem("gallery_scrollY", window.scrollY);
});
