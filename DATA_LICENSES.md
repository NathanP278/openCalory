# Data Licenses & Attributions

The compiled MacroAI / openCalory food catalog artifacts (`food-catalog.db` and `food-catalog.db.gz`, both Core and Expanded packs) are distributed under the **Open Database License (ODbL) v1.0** (<https://opendatacommons.org/licenses/odbl/1-0/>) because they combine and deduplicate open datasets including ODbL-licensed sources (OpenNutrition and Open Food Facts).

> **Commercial API Policy:** MacroAI NEVER scrapes, dumps, or compiles proprietary/commercial APIs (such as FatSecret, Edamam, or Nutritionix) into offline catalog artifacts.

## Upstream Dataset Attributions

| Dataset | Publisher / Maintainer | License | Region | Notes |
| --- | --- | --- | --- | --- |
| **USDA FoodData Central** (Foundation Foods, SR Legacy, FNDDS, Branded Foods) | U.S. Department of Agriculture, Agricultural Research Service | **CC0 1.0 / Public Domain** | US / Global | Laboratory-analyzed whole foods, survey foods, and label data (<https://fdc.nal.usda.gov/>). |
| **OpenNutrition Dataset** | OpenNutrition Contributors | **ODbL-1.0** | Global | Everyday, grocery, prepared, and restaurant nutrition data (<https://www.opennutrition.app/>). |
| **Open Food Facts** | Open Food Facts Association & Contributors | **ODbL-1.0** | Global (SEA, East Asia, EU, Oceania, Americas) | Crowdsourced packaged food barcodes & nutrition facts (<https://world.openfoodfacts.org/>). |
| **FoodRepo (OpenFood.ch)** | EPFL Digital Epidemiology Lab | **CC BY 4.0** | CH / EU | Barcoded packaged food nutrition database (<https://www.foodrepo.org/>). |
| **Canadian Nutrient File (CNF)** | Health Canada | **Open Government Licence – Canada** | CA | Official Canadian food composition database. |
| **UK CoFID (McCance & Widdowson)** | Public Health England / Quadram Institute | **Open Government Licence v3.0** | GB | Composition of Foods Integrated Dataset. |
| **AUSNUT / Australian Food Composition Database** | Food Standards Australia New Zealand (FSANZ) | **CC BY 4.0** | AU | Official Australian nutrient composition tables. |
| **Japan MEXT Standard Tables of Food Composition** | Ministry of Education, Culture, Sports, Science and Technology (Japan) | **CC BY 4.0 / Japanese Government Open Data** | JP | Official Japanese food composition tables. |
| **Germany BLS 4.0 (Bundeslebensmittelschlüssel)** | Max Rubner-Institut (MRI) | **CC BY 4.0** | DE | German Nutrient Data Base. |
| **France ANSES-Ciqual** | Agence nationale de sécurité sanitaire (ANSES) | **Licence Ouverte / Open Licence v2.0** | FR | French food composition table (<https://ciqual.anses.fr/>). |
| **Netherlands NEVO** | RIVM (National Institute for Public Health and the Environment) | **CC0 / Public Domain** | NL | Dutch Food Composition Database. |
| **Denmark Frida** | DTU National Food Institute | **CC BY 4.0** | DK | Danish Food Composition Databank (<https://frida.fooddata.dk/>). |
| **Sweden Livsmedelsverket** | Swedish Food Agency | **CC BY 4.0 / Public Data** | SE | Official Swedish food composition database. |
| **Brazil TBCA / TACO** | NEPA-UNICAMP / USP | **Open Academic / CC BY** | BR | Brazilian Table of Food Composition. |
| **India Anuvaad INDB / NIN IFCT** | National Institute of Nutrition (ICMR) / Anuvaad Contributors | **CC BY 4.0** | IN | Indian Nutrient Databank & Indian Food Composition Tables. |
| **NYC DOHMH MenuStat** | New York City Department of Health and Mental Hygiene | **Public Domain** | US | Chain restaurant menu item nutrition dataset (<https://www.menustat.org/>). |
| **OpenNosh** | OpenNosh Community | **CC0 1.0** | Global | Community-curated open nutrition packs. |
| **MacroAI Curated Regional & Restaurant Packs** (`data/curated/*.json`) | MacroAI / openCalory Contributors | **ODbL-1.0 / CC0-1.0** | PH, SEA, East Asia, Global | Hand-curated regional dishes, staples, and chain menu items. |

## Reproducing or Extending the Catalog

- Core catalog (committed): `npm run food-db:build`
- Expanded catalog (local / self-hosted): `npm run food-db:build:expanded`
- Pull prebuilt Expanded catalog: `npm run food-db:pull`
