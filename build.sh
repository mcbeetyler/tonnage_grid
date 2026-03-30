#!/bin/bash
# Builds a standalone dashboard.html with all JS inlined
# Output: dashboard-standalone.html (open directly in Chrome, no server needed)

cd "$(dirname "$0")"

# Extract everything before the script tags
head_end=$(grep -n '<script src="parser.js">' dashboard.html | cut -d: -f1)
head_end=$((head_end - 1))
head -n "$head_end" dashboard.html > dashboard-standalone.html

# Inline parser.js
echo '<script>' >> dashboard-standalone.html
cat parser.js >> dashboard-standalone.html
echo '' >> dashboard-standalone.html
echo '</script>' >> dashboard-standalone.html

# Inline app.js with sample data embedded
echo '<script>' >> dashboard-standalone.html

# Embed sample data so loadSample() works without fetch
echo 'const SAMPLE_DATA = ' >> dashboard-standalone.html
cat sample_vessels.json >> dashboard-standalone.html
echo ';' >> dashboard-standalone.html
echo '' >> dashboard-standalone.html

# Inline app.js but patch loadSample to use embedded data
sed 's/async function loadSample() {/function loadSample() {/' app.js | \
sed 's/const resp = await fetch.*$/\/\/ Using embedded data/' | \
sed 's/const data = await resp.json();/const data = SAMPLE_DATA;/' | \
sed '/Could not load sample_vessels/d' | \
sed '/Fallback/d' \
>> dashboard-standalone.html

echo '</script>' >> dashboard-standalone.html
echo '</body>' >> dashboard-standalone.html
echo '</html>' >> dashboard-standalone.html

echo "Built: dashboard-standalone.html"
echo "Open it directly in Chrome - no server needed."
