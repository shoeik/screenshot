// ==============================
// DOM
// ==============================
const gallery = document.getElementById("gallery");
const tagArea = document.getElementById("tag-area");
const selectedTagsWrap = document.getElementById("selected-tags");
const searchInput = document.getElementById("search");
const viewToggleButtons = document.querySelectorAll(".view-toggle button");
const imageViewButtons = document.querySelectorAll("[data-image-view]");

// ==============================
// State
// ==============================
let allItems = [];
let filteredItems = [];
let siteRecords = new Map();
let selectedTagsAND = [];
let selectedTagsOR = [];
let imageViewMode = "thumb";

const filterState = {
	topOnly: true
};

const displayState = {
	pc: true,
	sp: true
};

// ==============================
// Init
// ==============================
(async function init() {
	try {
		restoreSearch();
		restoreTagState();
		syncViewToggleButtons();
		syncImageViewButtons();
		applyImageViewMode();

		const indexList = await fetchJson("../screenshots_db/index.json");
		allItems = await loadItemsFromIndex(indexList);

		setupTagArea();
		applyFilters();
		restoreScrollPosition();
	} catch (error) {
		console.error("初期化エラー:", error);
		gallery.innerHTML = "<p>データの読み込みに失敗しました</p>";
	}
})();

async function fetchJson(path) {
	const response = await fetch(path, { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`${path} の読み込みに失敗しました (${response.status})`);
	}
	return response.json();
}

async function loadItemsFromIndex(indexList) {
	const items = [];
	siteRecords = new Map();

	for (const entry of indexList) {
		if (!entry?.json) continue;

		const siteJson = await fetchJson(resolveSiteJsonPath(entry.json));
		const siteRecord = createSiteRecord(siteJson, entry);
		siteRecords.set(entry.json, siteRecord);
		items.push(...flattenSiteJson(siteJson, entry, siteRecord));
	}

	return items;
}

function createSiteRecord(siteJson, siteEntry) {
	return {
		siteId: siteEntry.id || "",
		sourceJson: siteEntry.json || "",
		tags: normalizeTags(siteJson._site?.tags || [])
	};
}

function resolveSiteJsonPath(jsonPath) {
	if (/^https?:\/\//.test(jsonPath) || jsonPath.startsWith("/")) {
		return jsonPath;
	}
	return `../${jsonPath}`;
}

function flattenSiteJson(siteJson, siteEntry, siteRecord) {
	return Object.entries(siteJson).filter(([url]) => url !== "_site").map(([url, page]) => {
		const meta = page.meta || {};
		const sourceJson = siteEntry.json || "";

		return {
			id: `${siteEntry.id || meta.domain || "site"}:${url}`,
			siteId: siteEntry.id || meta.domain || "",
			sourceJson,
			site: siteRecord,
			url,
			meta,
			assets: page.assets || {},
			analysis: page.analysis || {},
			tags: Array.isArray(page.tags) ? page.tags : [],
			title: meta.slug || url
		};
	});
}

// ==============================
// Filters
// ==============================
function applyFilters() {
	const keyword = searchInput.value.trim().toLowerCase();
	pruneUnavailableSelectedTags();

	filteredItems = allItems.filter(item => {
		return (
			matchesTopFilter(item) &&
			matchesKeyword(item, keyword) &&
			matchesTagFilters(item) &&
			(hasVisibleImage(item) || hasVisibleVideo(item))
		);
	});

	renderSelectedTags();
	setupTagArea();
	renderGallery(filteredItems);
}

function matchesTopFilter(item) {
	if (!filterState.topOnly) return true;
	return item.meta?.slug === "top" || item.meta?.path === "/" || item.meta?.depth === 0;
}

function matchesKeyword(item, keyword) {
	if (!keyword) return true;

	const values = [
		item.meta?.slug,
		item.meta?.url,
		item.meta?.domain,
		item.url,
		item.siteId
	];

	return values.some(value => String(value || "").toLowerCase().includes(keyword));
}

function matchesTagFilters(item) {
	if (!selectedTagsAND.length && !selectedTagsOR.length) return true;

	const tags = getFilterTagsForItem(item);
	const andOK = selectedTagsAND.every(tag => tags.includes(tag));
	const orOK = selectedTagsOR.length === 0 || selectedTagsOR.some(tag => tags.includes(tag));

	return andOK && orOK;
}

function getFilterTagsForItem(item) {
	return normalizeTags([
		...(item.tags || []),
		...getSiteTagsForItem(item)
	]);
}

function hasVisibleImage(item) {
	const images = item.assets?.image || {};
	return Boolean((displayState.pc && images.pc) || (displayState.sp && images.sp));
}

function hasVisibleVideo(item) {
	const videos = item.assets?.video || {};
	return Boolean((displayState.pc && videos.pc) || (displayState.sp && videos.sp));
}

function getVisibleImages(item) {
	const images = item.assets?.image || {};
	const visibleImages = [];

	if (displayState.pc && images.pc) {
		visibleImages.push({ type: "pc", label: "PC", src: images.pc });
	}

	if (displayState.sp && images.sp) {
		visibleImages.push({ type: "sp", label: "SP", src: images.sp });
	}

	return visibleImages;
}

function getVisibleVideos(item) {
	const videos = item.assets?.video || {};
	const visibleVideos = [];

	if (displayState.pc && videos.pc) {
		visibleVideos.push({ type: "pc", label: "PC", src: videos.pc });
	}

	if (displayState.sp && videos.sp) {
		visibleVideos.push({ type: "sp", label: "SP", src: videos.sp });
	}

	return visibleVideos;
}

// ==============================
// Gallery rendering
// ==============================
function renderGallery(items) {
	gallery.innerHTML = "";
	applyImageViewMode();

	if (!items.length) {
		gallery.innerHTML = "<p>表示するデータがありません</p>";
		return;
	}

	items.forEach(item => {
		const visibleImages = getVisibleImages(item);
		const visibleVideos = getVisibleVideos(item);
		if (!visibleImages.length && !visibleVideos.length) return;

		const card = document.createElement("div");
		card.className = "item";

		const link = document.createElement("a");
		link.href = item.meta?.url || item.url || "#";
		link.target = "_blank";
		link.rel = "noopener noreferrer";

		const thumbs = document.createElement("div");
		thumbs.className = "thumbs";

		visibleImages.forEach(image => {
			const figure = document.createElement("figure");
			figure.className = `thumb ${image.type}`;

			const img = document.createElement("img");
			img.src = image.src;
			img.alt = `${item.title} ${image.label}`;
			img.loading = "lazy";

			figure.appendChild(img);
			thumbs.appendChild(figure);
		});

		link.appendChild(thumbs);
		card.appendChild(link);

		// 動画は <a> の外に置く（再生コントロール操作でリンク遷移しないように）
		if (visibleVideos.length) {
			const videos = document.createElement("div");
			videos.className = "videos";

			visibleVideos.forEach(video => {
				const figure = document.createElement("figure");
				figure.className = `video ${video.type}`;

				const player = document.createElement("video");
				player.src = video.src;
				player.controls = true;
				player.muted = true;
				player.playsInline = true;
				player.preload = "metadata";

				figure.appendChild(player);
				videos.appendChild(figure);
			});

			card.appendChild(videos);
		}

		const title = document.createElement("div");
		title.className = "title";
		title.textContent = item.title || "";
		card.appendChild(title);

		const url = document.createElement("div");
		url.className = "url";
		url.textContent = item.meta?.url || item.url || "";
		card.appendChild(url);

		if (isTopPage(item)) {
			card.appendChild(createSiteTagEditor(item));
		}

		card.appendChild(createItemTagEditor(item));

		gallery.appendChild(card);
	});
}

function createItemTagEditor(item) {
	return createTagEditor({
		item,
		label: "Page Tags",
		className: "page-tag-editor",
		tags: normalizeTags(item.tags),
		getAvailableTags: () => getAvailablePageTagsForItem(item),
		onAddTag: tag => addTagToItem(item, tag),
		onRemoveTag: tag => removeTagFromItem(item, tag),
		emptyText: "追加できる既存ページタグなし"
	});
}

function createSiteTagEditor(item) {
	return createTagEditor({
		item,
		label: "Site Tags",
		className: "site-tag-editor",
		tags: getSiteTagsForItem(item),
		getAvailableTags: () => getAvailableSiteTagsForItem(item),
		onAddTag: tag => addSiteTagToItem(item, tag),
		onRemoveTag: tag => removeSiteTagFromItem(item, tag),
		emptyText: "追加できる既存サイトタグなし"
	});
}

function createTagEditor({ item, label, className, tags, getAvailableTags, onAddTag, onRemoveTag, emptyText }) {
	const tagEditor = document.createElement("div");
	tagEditor.className = `tag-editor ${className}`;

	const title = document.createElement("div");
	title.className = "tag-editor-label";
	title.textContent = label;
	tagEditor.appendChild(title);

	const tagList = document.createElement("div");
	tagList.className = "tag-list";

	normalizeTags(tags).forEach(tag => {
		const chip = document.createElement("span");
		chip.className = "tag-chip";
		chip.dataset.tag = tag;

		const name = document.createElement("span");
		name.className = "name";
		name.textContent = tag;
		name.addEventListener("click", () => selectTagAsAND(tag));
		name.addEventListener("contextmenu", event => {
			event.preventDefault();
			selectTagAsOR(tag);
		});

		const remove = document.createElement("span");
		remove.className = "remove";
		remove.textContent = "×";
		remove.addEventListener("click", event => {
			event.stopPropagation();
			onRemoveTag(tag);
		});

		chip.appendChild(name);
		chip.appendChild(remove);
		tagList.appendChild(chip);
	});

	const addButton = document.createElement("span");
	addButton.className = "tag-add";
	addButton.textContent = "+追加";
	addButton.addEventListener("click", event => {
		event.stopPropagation();
		const isOpen = addMenu.classList.contains("is-open");
		closeAllTagAddMenus();
		addMenu.classList.toggle("is-open", !isOpen);
		if (!isOpen) {
			positionTagAddMenu(addButton, addMenu);
		}
	});

	tagList.appendChild(addButton);

	const addMenu = createTagAddMenu({
		getAvailableTags,
		onAddTag,
		emptyText
	});
	tagEditor.appendChild(tagList);
	tagEditor.appendChild(addMenu);

	return tagEditor;
}

function createTagAddMenu({ getAvailableTags, onAddTag, emptyText }) {
	const menu = document.createElement("div");
	menu.className = "tag-add-menu";
	menu.addEventListener("click", event => event.stopPropagation());

	const availableTags = getAvailableTags();

	if (availableTags.length) {
		const candidates = document.createElement("div");
		candidates.className = "tag-candidates";

		availableTags.forEach(tag => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "tag-candidate";
			button.textContent = tag;
			button.addEventListener("click", () => onAddTag(tag));
			candidates.appendChild(button);
		});

		menu.appendChild(candidates);
	} else {
		const empty = document.createElement("div");
		empty.className = "tag-candidates-empty";
		empty.textContent = emptyText;
		menu.appendChild(empty);
	}

	const promptButton = document.createElement("button");
	promptButton.type = "button";
	promptButton.className = "tag-new-button";
	promptButton.textContent = "新規タグを入力";
	promptButton.addEventListener("click", () => addNewTagByPrompt(onAddTag));
	menu.appendChild(promptButton);

	return menu;
}

function closeAllTagAddMenus() {
	document.querySelectorAll(".tag-add-menu.is-open").forEach(menu => {
		menu.classList.remove("is-open");
		menu.closest(".item")?.classList.remove("has-open-tag-menu");
	});
}

function positionTagAddMenu(addButton, menu) {
	const card = addButton.closest(".item");
	if (!card) return;

	card.classList.add("has-open-tag-menu");

	const cardRect = card.getBoundingClientRect();
	const buttonRect = addButton.getBoundingClientRect();
	const menuRect = menu.getBoundingClientRect();
	const padding = 12;
	const gap = 8;
	const maxLeft = Math.max(padding, cardRect.width - menuRect.width - padding);
	const preferredLeft = buttonRect.left - cardRect.left;
	const left = Math.min(Math.max(preferredLeft, padding), maxLeft);
	const preferredTop = buttonRect.top - cardRect.top - menuRect.height - gap;
	const top = Math.max(padding, preferredTop);

	menu.style.left = `${left}px`;
	menu.style.top = `${top}px`;
}

function addNewTagByPrompt(onAddTag) {
	const tag = normalizeTag(prompt("追加するタグを入力"));
	if (!tag) return;
	onAddTag(tag);
}

function normalizeTag(tag) {
	return String(tag || "").trim();
}

function addTagToItem(item, tag) {
	item.tags = Array.isArray(item.tags) ? item.tags : [];
	const normalizedTag = normalizeTag(tag);

	if (normalizedTag && !item.tags.includes(normalizedTag)) {
		item.tags.push(normalizedTag);
		item.tags = normalizeTags(item.tags);
		saveTags(item);
	}

	applyFilters();
}

function removeTagFromItem(item, tag) {
	item.tags = Array.isArray(item.tags) ? item.tags : [];
	item.tags = item.tags.filter(current => current !== tag);
	item.tags = normalizeTags(item.tags);
	saveTags(item);

	applyFilters();
}

function addSiteTagToItem(item, tag) {
	const normalizedTag = normalizeTag(tag);
	const siteTags = getSiteTagsForItem(item);

	if (normalizedTag && !siteTags.includes(normalizedTag)) {
		setSiteTagsForItem(item, [...siteTags, normalizedTag]);
		saveSiteTags(item);
	}

	applyFilters();
}

function removeSiteTagFromItem(item, tag) {
	const siteTags = getSiteTagsForItem(item).filter(current => current !== tag);
	setSiteTagsForItem(item, siteTags);
	saveSiteTags(item);

	applyFilters();
}

function normalizeTags(tags) {
	return [...new Set(
		(tags || [])
			.map(tag => normalizeTag(tag))
			.filter(Boolean)
	)];
}

function getAllTags() {
	return [...new Set([
		...allItems.flatMap(item => normalizeTags(item.tags)),
		...getAllSiteTags()
	])].sort((a, b) => {
		return a.localeCompare(b, "ja");
	});
}

function getAllSiteTags() {
	return [...new Set([...siteRecords.values()].flatMap(site => normalizeTags(site.tags)))];
}

function getAvailablePageTagsForItem(item) {
	const itemTags = new Set(normalizeTags(item.tags));
	return getAllTags().filter(tag => !itemTags.has(tag));
}

function getAvailableSiteTagsForItem(item) {
	const siteTags = new Set(getSiteTagsForItem(item));
	return getAllTags().filter(tag => !siteTags.has(tag));
}

function getSiteTagsForItem(item) {
	return normalizeTags(item.site?.tags || []);
}

function setSiteTagsForItem(item, tags) {
	if (!item.site) {
		item.site = {
			siteId: item.siteId || "",
			sourceJson: item.sourceJson || "",
			tags: []
		};
		siteRecords.set(item.sourceJson, item.site);
	}

	item.site.tags = normalizeTags(tags);
}

function isTopPage(item) {
	return item.meta?.slug === "top" || item.meta?.path === "/" || item.meta?.depth === 0;
}

async function saveTags(item) {
	try {
		const response = await fetch("/api/save-tags", {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				jsonPath: item.sourceJson,
				url: item.url,
				tags: normalizeTags(item.tags)
			})
		});

		const result = await response.json().catch(() => ({}));

		if (!response.ok || !result.ok) {
			throw new Error(result.error || `HTTP ${response.status}`);
		}
	} catch (error) {
		console.error("タグ保存に失敗しました:", error, item);
	}
}

async function saveSiteTags(item) {
	try {
		const response = await fetch("/api/save-site-tags", {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				jsonPath: item.sourceJson,
				tags: getSiteTagsForItem(item)
			})
		});

		const result = await response.json().catch(() => ({}));

		if (!response.ok || !result.ok) {
			throw new Error(result.error || `HTTP ${response.status}`);
		}
	} catch (error) {
		console.error("サイトタグ保存に失敗しました:", error, item);
	}
}

// ==============================
// Tag UI
// ==============================
function setupTagArea() {
	tagArea.innerHTML = "";

	getAllTags().forEach(tag => {
		const button = document.createElement("span");
		button.className = "tag";
		button.textContent = tag;

		if (selectedTagsAND.includes(tag)) {
			button.classList.add("tag-and");
		} else if (selectedTagsOR.includes(tag)) {
			button.classList.add("tag-or");
		} else {
			button.classList.add("tag-off");
		}

		button.addEventListener("click", () => toggleTagAsAND(tag));
		button.addEventListener("contextmenu", event => {
			event.preventDefault();
			toggleTagAsOR(tag);
		});

		tagArea.appendChild(button);
	});
}

function renderSelectedTags() {
	selectedTagsWrap.innerHTML = "";

	renderSelectedTagGroup("AND", "tag-and", selectedTagsAND);
	renderSelectedTagGroup("OR", "tag-or", selectedTagsOR);
}

function renderSelectedTagGroup(label, className, tags) {
	tags.forEach(tag => {
		const selectedTag = document.createElement("div");
		selectedTag.className = `selected-tag ${className}`;
		selectedTag.textContent = `${label}: ${tag}`;

		const close = document.createElement("span");
		close.className = "close";
		close.textContent = "×";
		close.addEventListener("click", () => {
			removeSelectedTag(tag);
			applyFilters();
		});

		selectedTag.appendChild(close);
		selectedTagsWrap.appendChild(selectedTag);
	});
}

function toggleTagAsAND(tag) {
	if (selectedTagsAND.includes(tag)) {
		selectedTagsAND = selectedTagsAND.filter(current => current !== tag);
	} else {
		selectTagAsAND(tag);
		return;
	}

	saveTagState();
	applyFilters();
}

function toggleTagAsOR(tag) {
	if (selectedTagsOR.includes(tag)) {
		selectedTagsOR = selectedTagsOR.filter(current => current !== tag);
	} else {
		selectTagAsOR(tag);
		return;
	}

	saveTagState();
	applyFilters();
}

function selectTagAsAND(tag) {
	if (!selectedTagsAND.includes(tag)) {
		selectedTagsAND.push(tag);
	}
	selectedTagsOR = selectedTagsOR.filter(current => current !== tag);

	saveTagState();
	applyFilters();
}

function selectTagAsOR(tag) {
	if (!selectedTagsOR.includes(tag)) {
		selectedTagsOR.push(tag);
	}
	selectedTagsAND = selectedTagsAND.filter(current => current !== tag);

	saveTagState();
	applyFilters();
}

function removeSelectedTag(tag) {
	selectedTagsAND = selectedTagsAND.filter(current => current !== tag);
	selectedTagsOR = selectedTagsOR.filter(current => current !== tag);
	saveTagState();
}

function pruneUnavailableSelectedTags() {
	const availableTags = new Set(getAllTags());
	const nextAND = selectedTagsAND.filter(tag => availableTags.has(tag));
	const nextOR = selectedTagsOR.filter(tag => availableTags.has(tag));
	const changed = nextAND.length !== selectedTagsAND.length || nextOR.length !== selectedTagsOR.length;

	selectedTagsAND = nextAND;
	selectedTagsOR = nextOR;

	if (changed) {
		saveTagState();
	}
}

// ==============================
// UI events
// ==============================
viewToggleButtons.forEach(button => {
	button.addEventListener("click", () => {
		const key = button.dataset.view;

		if (key === "top") {
			filterState.topOnly = !filterState.topOnly;
		}

		if (key === "pc" || key === "sp") {
			displayState[key] = !displayState[key];
		}

		syncViewToggleButtons();
		applyFilters();
	});
});

imageViewButtons.forEach(button => {
	button.addEventListener("click", () => {
		const mode = button.dataset.imageView;
		if (!["thumb", "scroll", "full"].includes(mode)) return;

		imageViewMode = mode;
		syncImageViewButtons();
		applyImageViewMode();
	});
});

searchInput.addEventListener("input", () => {
	localStorage.setItem("search_keyword", searchInput.value);
	applyFilters();
});

window.addEventListener("scroll", () => {
	localStorage.setItem("gallery_scrollY", String(window.scrollY));
});

document.addEventListener("click", closeAllTagAddMenus);

function syncViewToggleButtons() {
	viewToggleButtons.forEach(button => {
		const key = button.dataset.view;

		if (key === "top") {
			button.classList.toggle("is-active", filterState.topOnly);
		}

		if (key === "pc" || key === "sp") {
			button.classList.toggle("is-active", displayState[key]);
		}
	});
}

function syncImageViewButtons() {
	imageViewButtons.forEach(button => {
		button.classList.toggle("is-active", button.dataset.imageView === imageViewMode);
	});
}

function applyImageViewMode() {
	gallery.classList.remove("view-thumb", "view-scroll", "view-full");
	gallery.classList.add(`view-${imageViewMode}`);
}

// ==============================
// LocalStorage
// ==============================
function restoreSearch() {
	const savedKeyword = localStorage.getItem("search_keyword");
	if (savedKeyword) {
		searchInput.value = savedKeyword;
	}
}

function saveTagState() {
	localStorage.setItem("selectedTagsAND", JSON.stringify(selectedTagsAND));
	localStorage.setItem("selectedTagsOR", JSON.stringify(selectedTagsOR));
}

function restoreTagState() {
	selectedTagsAND = parseStoredArray("selectedTagsAND");
	selectedTagsOR = parseStoredArray("selectedTagsOR");
}

function parseStoredArray(key) {
	try {
		const value = JSON.parse(localStorage.getItem(key) || "[]");
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

function restoreScrollPosition() {
	const savedY = Number(localStorage.getItem("gallery_scrollY") || 0);
	if (savedY > 0) {
		window.scrollTo(0, savedY);
	}
}
