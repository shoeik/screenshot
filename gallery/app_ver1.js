let data = [];
let filtered = [];
let selectedTags = [];


const gallery = document.getElementById("gallery");
const searchInput = document.getElementById("search");
const categorySelect = document.getElementById("filter-category");
const industrySelect = document.getElementById("filter-industry");
const sortSelect = document.getElementById("sort");
const tagArea = document.getElementById("tag-area");

// 初期化
(async function init() {
	data = await fetch("../screenshots.json").then(res => res.json());
	filtered = data;

	setupFilters();
	renderGallery();
	setupTagArea();
	renderSelectedTags();
})();

// フィルタセットアップ
function setupFilters() {
	const categories = [...new Set(data.map(d => d.category))];
	const industries = [...new Set(data.map(d => d.industry))];
	const siteTypes = [...new Set(data.map(d => d.siteType))];
	const tags = [...new Set(data.flatMap(d => d.tags))];

	categories.forEach(c => {
		const opt = document.createElement("option");
		opt.value = c;
		opt.textContent = c;
		categorySelect.appendChild(opt);
	});

	industries.forEach(i => {
		const opt = document.createElement("option");
		opt.value = i;
		opt.textContent = i;
		industrySelect.appendChild(opt);
	});

	siteTypes.forEach(st => {
		const opt = document.createElement("option");
		opt.value = st;
		opt.textContent = st;
		document.getElementById("filter-siteType").appendChild(opt);
	});

	// tags.forEach(t => {
	// 	const span = document.createElement("span");
	// 	span.classList.add("tag");
	// 	span.textContent = t;
	// 	span.onclick = () => {
	// 	searchInput.value = t;
	// 	applyFilters();
	// 	};
	// 	tagArea.appendChild(span);
	// });
}


function setupTagArea() {
	tagArea.innerHTML = "";

	const tags = [...new Set(data.flatMap(d => d.tags))];

	tags.forEach(t => {
		const span = document.createElement("span");
		span.classList.add("tag");
		if (selectedTags.includes(t)) span.classList.add("active");

		span.textContent = t;

		span.onclick = () => {
		if (selectedTags.includes(t)) {
			selectedTags = selectedTags.filter(x => x !== t);
		} else {
			selectedTags.push(t);
		}
		applyFilters();
		setupTagArea(); // 再描画
		renderSelectedTags();
		};

		tagArea.appendChild(span);
	});
}



// レンダリング
function renderGallery() {
	gallery.innerHTML = "";

	filtered.forEach(item => {
		const div = document.createElement("div");
		div.className = "item";

		div.innerHTML = `
		<a href="${item.url}" target="_blank">
			<img src="${item.file}" loading="lazy">
		</a>
		<div>${item.title}</div>
		<div class="url">${item.url}</div>
		`;

		gallery.appendChild(div);
	});
}

function renderSelectedTags() {
	const wrap = document.getElementById("selected-tags");
	wrap.innerHTML = "";

	selectedTags.forEach(t => {
		const div = document.createElement("div");
		div.className = "selected-tag";

		div.innerHTML = `
		${t}
		<span class="close">×</span>
		`;

		div.querySelector(".close").onclick = () => {
		selectedTags = selectedTags.filter(x => x !== t);
		applyFilters();
		setupTagArea();
		renderSelectedTags();
		};

		wrap.appendChild(div);
	});
}


// フィルタ適用
searchInput.oninput = applyFilters;
categorySelect.onchange = applyFilters;
industrySelect.onchange = applyFilters;
sortSelect.onchange = applyFilters;

function applyFilters() {
	let result = [...data];

	const keyword = searchInput.value.toLowerCase();
	if (keyword) {
		result = result.filter(d =>
		(d.title && d.title.toLowerCase().includes(keyword)) ||
		(d.url && d.url.toLowerCase().includes(keyword)) ||
		d.tags.some(t => t.toLowerCase().includes(keyword))
		);
	}

	const cat = categorySelect.value;
	if (cat) result = result.filter(d => d.category === cat);

	const ind = industrySelect.value;
	if (ind) result = result.filter(d => d.industry === ind);

	// ソート
	if (sortSelect.value === "date_desc") {
		result.sort((a, b) => new Date(b.date) - new Date(a.date));
	} else if (sortSelect.value === "date_asc") {
		result.sort((a, b) => new Date(a.date) - new Date(b.date));
	} else if (sortSelect.value === "site_asc") {
		result.sort((a, b) => a.site.localeCompare(b.site));
	}
	
	// タグの AND 条件フィルタ
	if (selectedTags.length > 0) {
		result = result.filter(d =>
			selectedTags.every(tag => d.tags.includes(tag))
		);
	}

	filtered = result;
	renderGallery();
}
