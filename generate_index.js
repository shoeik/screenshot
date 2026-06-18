const fs = require("fs");
const path = require("path");

const BASE_DIR = path.resolve(__dirname, "./screenshots_db");
const OUTPUT_FILE = path.join(BASE_DIR, "index.json");

// index.json に含めないファイル
const IGNORE_FILES = ["index.json"];

function generateIndex() {
  const files = fs.readdirSync(BASE_DIR)
    .filter(f => f.endsWith(".json"))
    .filter(f => !IGNORE_FILES.includes(f));

  const index = [];

  for (const file of files) {
    const fullPath = path.join(BASE_DIR, file);

    let data;
    try {
      data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch (e) {
      console.warn(`⚠️ JSON parse error: ${file}`);
      continue;
    }

    // 最初の1件だけ使う（トップページ想定）
    const firstKey = Object.keys(data)[0];
    if (!firstKey) continue;

    const entry = data[firstKey];

    index.push({
      id: file.replace(".json", ""),
      json: `screenshots_db/${file}`,
    });
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(index, null, 2),
    "utf-8"
  );

  console.log(`✅ index.json generated (${index.length} entries)`);
}

generateIndex();
