# Geography v3 (GSHHG) — provenance, pipeline and limits

Date: 2026-11-28. Replaces the Natural Earth 10m runtime dots (v2) in response to the
project owner's request for more accurate minute detail.

## Source

- Dataset: GSHHG 2.3.7 (Global Self-consistent, Hierarchical, High-resolution Geography),
  Wessel & Smith, SOEST/NOAA.
- Project page: https://www.soest.hawaii.edu/pwessel/gshhg/
- Downloaded artifact: https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-bin-2.3.7.zip
  (native binary distribution, ~119 MB).
- NOAA host page: https://ngdc.noaa.gov/mgg/shorelines/shorelines.html
- License: GNU Lesser General Public License v3 or later. The unmodified license texts
  ship in this repo as 3-GSHHG-LICENSE.TXT and 4-GSHHG-COPYING.LESSERv3 (as extracted
  from the distribution). Redistribution obligations: keep the LGPL-3.0+ license texts
  with any redistribution of the data or derivatives, state the source and the license,
  and keep notices intact. These notes satisfy the notice/attribution part; they are a
  summary, not legal advice.

## What was used

- Resolution "high" (h), level 1 (land): 144,744 polygons, 1.63M vertices, median vertex
  spacing ~1.08 km. Rings with >60 vertices decimated to ~2.5 km spacing; islands the
  high resolution drops (35,088, present only in the full "f" resolution) kept at ~0.4 km.
- Levels 2 (lakes), 3 (islands in lakes), 4 (ponds on level-3 islands) and 5 (Antarctica
  ice front) included so inland waters such as the Kerala backwaters are represented;
  they are not part of shoreline level 1.
- Reference: full "f" level 1 measures 179,832 polygons / 9.45M vertices, median vertex
  spacing ~0.80 km (used only to recover the small islands "h" decimates away).

## Baked artifacts in this repo

- 5-coast.bin.gz (4,715,001 B gzip; 9.4 MB raw): 188,206 polygons, 1,364,631 segments,
  415 chunks of 10 degrees. Custom container "GSH1": u32 magic, u16 version, u16 chunk
  count, then per chunk f32 lon0, f32 lat0, u32 segment count, then per segment 2x
  (u16 longitude offset in arcseconds from lon0, u16 latitude offset from lat0).
  Rendered as frustum-culled LineSegments whose opacity ramps with camera distance.
- 2-dots-gshhg.bin.gz (1,762,352 B gzip; 1,988,208 B raw): 248,526 dots as float32
  lat/lon pairs = 66,931 fibonacci samples on a GSHHG land mask (same density as the
  approved v2 set) + 181,595 guaranteed per-polygon first-vertex dots, so every land
  polygon down to small atolls carries at least one dot. Dot longitudes normalized to
  +/-180 (GSHHG stores some polygons 0..360).
- Land mask for sampling: 18000 x 9000 grid at 0.02 deg, rasterized offline from the
  same polygons with dateline-safe ring unwrapping.

## Verified behaviour

- Dots stop at the coastline line at deep zoom (checked at Kochi and the Maldives on the
  deployed build); dots baked on Natural Earth 10m would have sat offshore here, which is
  why they were re-baked rather than reused.
- Live transfer measured 2026-11-28 from the deployed site: 5-coast.bin.gz 4.72 MB and
  2-dots-gshhg.bin.gz 1.76 MB (gzip), both HTTP 200, fetched in ~0.32 s / ~0.18 s on a
  fast connection; on a software-rendered 390x844 viewport the full interactive globe
  (fetch + gunzip + AQI grid) settles within ~12 s. Real phone speeds vary; these are
  measurements of this pipeline, not promises.

## Limits (kept deliberately in the UI copy as well)

- GSHHG shorelines derive from World Vector Shorelines, nominal scale 1:250,000.
  They are dataset geometries, not surveys.
- Vertex spacing, storage precision and polygon counts say nothing about positional
  accuracy; no numerical geographic accuracy claim is made anywhere in the product.
- AQI colours are interpolated from the CAMS model grid, not point measurements.
