const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8765;
const ROOT_DIR = __dirname;
const SCREENSHOTS_DB_DIR = path.join(ROOT_DIR, "screenshots_db");

app.use(express.json({ limit: "1mb" }));

app.use("/gallery", express.static(path.join(ROOT_DIR, "gallery")));
app.use("/screenshots_db", express.static(SCREENSHOTS_DB_DIR));
app.use("/screenshots", express.static(path.join(ROOT_DIR, "screenshots")));

app.get("/", (req, res) => {
	res.redirect("/gallery/index.html");
});

app.post("/api/save-tags", async (req, res) => {
	try {
		const { jsonPath, url, tags } = req.body || {};

		if (!isValidJsonPath(jsonPath)) {
			return res.status(400).json({ ok: false, error: "invalid_json_path" });
		}

		if (typeof url !== "string" || !url.trim()) {
			return res.status(400).json({ ok: false, error: "invalid_url" });
		}

		if (!Array.isArray(tags)) {
			return res.status(400).json({ ok: false, error: "invalid_tags" });
		}

		const filePath = resolveJsonPath(jsonPath);
		const raw = await fs.readFile(filePath, "utf8");
		const data = JSON.parse(raw);

		if (!data[url]) {
			return res.status(404).json({ ok: false, error: "url_not_found" });
		}

		data[url].tags = normalizeTags(tags);

		await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		return res.json({ ok: true });
	} catch (error) {
		console.error("save-tags error:", error);
		return res.status(500).json({ ok: false, error: "save_failed" });
	}
});

app.post("/api/save-site-tags", async (req, res) => {
	try {
		const { jsonPath, tags } = req.body || {};

		if (!isValidJsonPath(jsonPath)) {
			return res.status(400).json({ ok: false, error: "invalid_json_path" });
		}

		if (!Array.isArray(tags)) {
			return res.status(400).json({ ok: false, error: "invalid_tags" });
		}

		const filePath = resolveJsonPath(jsonPath);
		const raw = await fs.readFile(filePath, "utf8");
		const data = JSON.parse(raw);

		if (!data._site || typeof data._site !== "object" || Array.isArray(data._site)) {
			data._site = {};
		}

		data._site.tags = normalizeTags(tags);

		await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		return res.json({ ok: true });
	} catch (error) {
		console.error("save-site-tags error:", error);
		return res.status(500).json({ ok: false, error: "save_failed" });
	}
});

function isValidJsonPath(jsonPath) {
	if (typeof jsonPath !== "string") return false;

	const normalized = path.posix.normalize(jsonPath.replace(/\\/g, "/"));
	if (!normalized.startsWith("screenshots_db/")) return false;
	if (!normalized.endsWith(".json")) return false;
	if (path.posix.basename(normalized) === "index.json") return false;
	if (normalized.includes("/../")) return false;

	return true;
}

function resolveJsonPath(jsonPath) {
	const normalized = path.posix.normalize(jsonPath.replace(/\\/g, "/"));
	const relativePath = normalized.replace(/^screenshots_db\//, "");
	const filePath = path.resolve(SCREENSHOTS_DB_DIR, relativePath);
	const relativeFromDb = path.relative(SCREENSHOTS_DB_DIR, filePath);

	if (relativeFromDb.startsWith("..") || path.isAbsolute(relativeFromDb)) {
		throw new Error("Resolved path escaped screenshots_db");
	}

	return filePath;
}

function normalizeTags(tags) {
	return [...new Set(
		tags
			.map(tag => String(tag || "").trim())
			.filter(Boolean)
	)];
}

app.listen(PORT, () => {
	console.log(`Gallery server running at http://127.0.0.1:${PORT}`);
});
