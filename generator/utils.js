const fs = require("fs");
const path = require("path");

function walkDir(dir, fileList = []) {
	const files = fs.readdirSync(dir);

	files.forEach(f => {
		const fullPath = path.join(dir, f);
		const stat = fs.statSync(fullPath);

		if (stat.isDirectory()) {
		walkDir(fullPath, fileList);
		} else {
		if (f.endsWith(".webp")) {
			fileList.push(fullPath);
		}
		}
	});

	return fileList;
	}

	function guessByMap(str, mapObj) {
	str = str.toLowerCase();

	for (const key in mapObj) {
		if (mapObj[key].some(k => str.includes(k.toLowerCase()))) {
		return key;
		}
	}
	return "";
}

module.exports = { walkDir, guessByMap };
