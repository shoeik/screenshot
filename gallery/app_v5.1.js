// ==============================
// State
// ==============================
let data = [];
let filtered = [];

let selectedTagsAND = [];
let selectedTagsOR = [];

// 表示切り替え（トグル）
let viewState = {
	pc: true,
	sp: true,
	top: true
};

const gallery = document.getElementById("gallery");
const tagArea = document.getElementById("tag-area");
const selectedTagsWrap = document.getElementById("selected-tags");
const searchInput = document.getElementById("search");

// ==============================
// LocalStorage
// ==============================
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
	selectedTagsOR  = JSON.parse(localStorage.getItem("selectedTagsOR") || "[]");
}

// ==============================
// 初期化
// ==============================
(async function init() {
	try {
		const raw = await fetch("../screenshots_db/mmslaw_jp.json").then(r => r.json());

		data = Object.entries(raw).map(([url, info]) => ({
			url,
			meta: info.meta,
			assets: info.assets,
			tags: info.tags || [],
			title: info.meta?.slug || url
		}));

		restoreSearch();
		restoreSelectedTags();
		setupTagArea();
		applyFilters();

		const savedY = localStorage.getItem("gallery_scrollY");
		if (savedY) window.scrollTo(0, Number(savedY));
	} catch (e) {
		console.error("❌ JSON読み込み失敗", e);
	}
})();

// ==============================
// VIEW TOGGLE
// ==============================
document.querySelectorAll(".view-toggle button").forEach(btn => {
	btn.addEventListener("click", () => {
		const key = btn.dataset.view;
		viewState[key] = !viewState[key];
		btn.classList.toggle("is-active", viewState[key]);
		applyFilters();
	});
});

// ==============================
// ギャラリー描画
// ==============================
function renderGallery() {
	gallery.innerHTML = "";

	if (!filtered.length) {
		gallery.innerHTML = "<p>データがありません</p>";
		return;
	}

	filtered.forEach(item => {
		const imgs = [];

		if (viewState.pc && item.assets?.image?.pc) {
			imgs.push({ src: item.assets.image.pc, label: "PC" });
		}

		if (viewState.sp && item.assets?.image?.sp) {
			imgs.push({ src: item.assets.image.sp, label: "SP" });
		}

		if (viewState.top) {
			if (item.meta?.slug === "top" || item.meta?.path === "/") {
				if (item.assets?.image?.pc) {
					imgs.push({ src: item.assets.image.pc, label: "PC" });
				}
				if (item.assets?.image?.sp) {
					imgs.push({ src: item.assets.image.sp, label: "SP" });
				}
			}
		}

		if (!imgs.length) return;

		const div = document.createElement("div");
		div.className = "item";

		div.innerHTML = `
			<a href="${item.url}" target="_blank" rel="noopener noreferrer">
				<div class="thumbs">
					${imgs.map(i => `
						<figure class="thumb ${i.label.toLowerCase()}">
							<img src="${i.src}" alt="${item.title} ${i.label}" loading="lazy">
						</figure>
					`).join("")}
				</div>
			</a>

			<div class="title">${item.title}</div>
			<div class="url">${item.url}</div>
		`;

		gallery.appendChild(div);
	});
}

// ==============================
// タグUI
// ==============================
function setupTagArea() {
	tagArea.innerHTML = "";

	const tags = [...new Set(data.flatMap(d => d.tags))];

	tags.forEach(tag => {
		const el = document.createElement("span");
		el.className = "tag";
		el.textContent = tag;

		if (selectedTagsAND.includes(tag)) el.classList.add("tag-and");
		else if (selectedTagsOR.includes(tag)) el.classList.add("tag-or");

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

// ==============================
// フィルタ処理
// ==============================
function applyFilters() {
	let result = [...data];

	const keyword = searchInput.value.trim().toLowerCase();
	if (keyword) {
		result = result.filter(d =>
			d.meta.slug.toLowerCase().includes(keyword) ||
			d.url.toLowerCase().includes(keyword)
		);
	}

	if (selectedTagsAND.length || selectedTagsOR.length) {
		result = result.filter(item => {
			const andOK = selectedTagsAND.every(t => item.tags.includes(t));
			const orOK = selectedTagsOR.length === 0 || selectedTagsOR.some(t => item.tags.includes(t));
			return andOK && orOK;
		});
	}

	filtered = result;
	renderGallery();
}

// ==============================
// スクロール位置保持
// ==============================
window.addEventListener("scroll", () => {
	localStorage.setItem("gallery_scrollY", window.scrollY);
});
