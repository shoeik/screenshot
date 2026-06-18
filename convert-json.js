const fs = require('fs');
const path = require('path');

const JSON_PATH = path.join(__dirname, "screenshots.json");
const OUTPUT_PATH = path.join(__dirname, "screenshots_array.json"); // バックアップ用

// ------------------------------
// 1. screenshots.json を読み込み
// ------------------------------
if (!fs.existsSync(JSON_PATH)) {
  console.error("❌ screenshots.json が見つかりません");
  process.exit(1);
}

const raw = fs.readFileSync(JSON_PATH, "utf8");

// 今の形式（辞書型）を読み込む
let dictData;
try {
  dictData = JSON.parse(raw);
} catch (err) {
  console.error("❌ JSON の読み込みに失敗:", err.message);
  process.exit(1);
}

// ------------------------------
// 2. 辞書型 → 配列型へ変換
// ------------------------------
const arrayData = Object.keys(dictData).map(key => {
  return {
    fileName: key,   // 元のキーも保持しておく（必要に応じて）
    ...dictData[key]
  };
});

// ------------------------------
// 3. arrayData を screenshots.json として上書き保存
//    ※ 念のため元データをバックアップ
// ------------------------------
fs.writeFileSync(
  OUTPUT_PATH,
  JSON.stringify(dictData, null, 2),
  "utf8"
);

fs.writeFileSync(
  JSON_PATH,
  JSON.stringify(arrayData, null, 2),
  "utf8"
);

console.log("✅ 変換完了！");
console.log(" - 配列形式に変換済み");
console.log(" - 元の辞書型は screenshots_array.json にバックアップ");