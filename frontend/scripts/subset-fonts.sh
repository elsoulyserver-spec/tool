#!/usr/bin/env bash
# ============================================================
# Easy Track — Font Subsetting Script
#
# Reduces Thmanyah WOFF2 files from ~77KB → ~30KB per weight
# by removing glyphs outside the UI character ranges.
#
# Requirements:
#   pip install fonttools brotli
#
# Run from project root:
#   bash scripts/subset-fonts.sh
#
# Output: public/fonts/thmanyahsans/ (overwrites originals)
# ============================================================

set -euo pipefail

INPUT_DIR="public/fonts/thmanyahsans-source"
OUTPUT_DIR="public/fonts/thmanyahsans"

mkdir -p "$OUTPUT_DIR"

# Unicode ranges to keep:
#   U+0020-007E  Basic Latin (ASCII — punctuation, digits, letters)
#   U+00A0-00FF  Latin-1 Supplement
#   U+0600-06FF  Arabic
#   U+0750-077F  Arabic Supplement
#   U+08A0-08FF  Arabic Extended-A
#   U+FB50-FDFF  Arabic Presentation Forms-A
#   U+FE70-FEFF  Arabic Presentation Forms-B
#   U+200B-200F  Zero-width spaces + bidi marks (critical for Arabic rendering)
#   U+2019,U+201C,U+201D  Typographic quotes
#   U+2026       Ellipsis (…)

UNICODES="U+0020-007E,U+00A0-00FF,U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200B-200F,U+2018-201D,U+2026"

WEIGHTS=("Regular" "Medium" "Bold")

for WEIGHT in "${WEIGHTS[@]}"; do
  INPUT="$INPUT_DIR/thmanyahsans-${WEIGHT}.otf"
  OUTPUT="$OUTPUT_DIR/thmanyahsans-${WEIGHT}.woff2"

  if [ ! -f "$INPUT" ]; then
    echo "⚠  Skipping $WEIGHT — source file not found: $INPUT"
    continue
  fi

  echo "→ Subsetting ThmanyahSans $WEIGHT..."

  pyftsubset "$INPUT" \
    --output-file="$OUTPUT" \
    --flavor=woff2 \
    --layout-features='*' \
    --unicodes="$UNICODES" \
    --name-IDs='*' \
    --no-hinting \
    --desubroutinize

  ORIGINAL_SIZE=$(wc -c < "$INPUT")
  SUBSET_SIZE=$(wc -c < "$OUTPUT")
  REDUCTION=$(( (ORIGINAL_SIZE - SUBSET_SIZE) * 100 / ORIGINAL_SIZE ))

  echo "   ✓ $WEIGHT: $(( ORIGINAL_SIZE / 1024 ))KB → $(( SUBSET_SIZE / 1024 ))KB (−${REDUCTION}%)"
done

echo ""
echo "✓ Subsetting complete. Files written to $OUTPUT_DIR/"
echo ""
echo "Performance budget check:"
echo "  Target: ≤ 32KB per weight (96KB total for 3 weights)"
TOTAL=0
for WEIGHT in "${WEIGHTS[@]}"; do
  FILE="$OUTPUT_DIR/thmanyahsans-${WEIGHT}.woff2"
  if [ -f "$FILE" ]; then
    SIZE=$(wc -c < "$FILE")
    TOTAL=$((TOTAL + SIZE))
    if [ "$SIZE" -gt 32768 ]; then
      echo "  ⚠  $WEIGHT: $(( SIZE / 1024 ))KB — EXCEEDS 32KB BUDGET"
    else
      echo "  ✓  $WEIGHT: $(( SIZE / 1024 ))KB"
    fi
  fi
done
echo "  Total: $(( TOTAL / 1024 ))KB (budget: 96KB)"
