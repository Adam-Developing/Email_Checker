# wikidata_to_sqlite.py – per-type fetch (200k per type)
"""
Fetch up to **200 000** organisations for *each individual Wikidata type*, storing
all combined results in a single SQLite database. This ensures broader coverage
by type (e.g. 200k Businesses, 200k Companies, 200k Museums, etc.).

Main changes:
-------------
* Iterates over each `type` individually instead of combining all types in one query
* Fetches up to 200 000 results for **each type**
* Appends to a shared `websites` table using INSERT OR IGNORE
* Logs the total number of rows fetched overall

Example usage:
--------------
```bash
python wikidata_to_sqlite.py
python wikidata_to_sqlite.py mydata.db --batch 30000
```
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path
from typing import Dict, List

from SPARQLWrapper import SPARQLWrapper, JSON, SPARQLExceptions

ENDPOINT_URL = "https://query.wikidata.org/sparql"
DEFAULT_MAX_RECORDS = 400_000
DEFAULT_BATCH_SIZE = 50_000
MAX_RETRIES = 5
BACKOFF_BASE = 5

USER_AGENT = (
    "AdamKhattab"
    "contact: github.com/AdamKhattabSolutions)"
)

TYPES = {
    # General & organisational
    "Business": "wd:Q4830453",
    "Company": "wd:Q783794",
    "Public company": "wd:Q891723",
    "Private company": "wd:Q5621421",
    "musical group": "wd:Q215380",
    "Multinational corporation": "wd:Q161726",
    "State‑owned enterprise": "wd:Q270791",
    "Holding company": "wd:Q219577",
    "Conglomerate Category": "wd:Q7050751",
    "Conglomerate": "wd:Q778575",
    "Nonprofit organization": "wd:Q163740",
    "Brand": "wd:Q431289",
    "Organisation": "wd:Q43229",

    # Retail & consumption
    "Shop": "wd:Q213441",
    "Supermarket": "wd:Q180846",
    "Supermarket chain": "wd:Q18043413",
    "Retail chain": "wd:Q507619",
    "E‑commerce company": "wd:Q484847",
    "Mobile application": "wd:Q620615",
    "Loyalty programme": "wd:Q1426546",
    "Shopping mall": "wd:Q31374404",
    "shopping center": "wd:Q11315",
    "Restaurant": "wd:Q11707",
    "Restaurant chain": "wd:Q18534542",
    "Fast-food restaurant chain": "wd:Q18509232",
    "Café": "wd:Q30022",
    "Bar": "wd:Q187456",
    "Pub": "wd:Q212198",

    # Finance & insurance
    "Bank": "wd:Q22687",
    "Investment bank": "wd:Q319845",
    "Insurance company": "wd:Q2143354",
    "Investment company": "wd:Q1752459",

    # Technology & telecoms
    "Technology company": "wd:Q18388277",
    "service on Internet": "wd:Q1668024",
    "software company": "wd:Q1058914",
    "record label": "wd:Q18127",
    "media company": "wd:Q1331793",
    "Telecommunications company": "wd:Q2401749",

    # Manufacturing & industry
    "Automotive manufacturer": "wd:Q786820",
    "Aerospace manufacturer": "wd:Q936518",
    "Pharmaceutical company": "wd:Q19644607",
    "Mining company": "wd:Q2990216",

    # Energy & utilities
    "Energy company": "wd:Q1341478",
    "Oil company": "wd:Q14941854",
    "Electric utility": "wd:Q1326624",

    # Transport & travel
    "Airline": "wd:Q46970",

    # Media & entertainment
    "film production company": "wd:Q1762059",
    "Entertainment company": "wd:Q20739124",
    "broadcaster": "wd:Q15265344",

    # Institutions / misc.
    "Educational institution": "wd:Q2385804",
    "University": "wd:Q3918",
    "School": "wd:Q3914",
    "Hospital": "wd:Q16917",
    "Museum": "wd:Q33506",
    "Library": "wd:Q7075",
    "Government agency": "wd:Q327333",
    "Political party": "wd:Q7278",
    "Trade union": "wd:Q49780",
    "Website": "wd:Q35127",
    "Social media platform": "wd:Q202833",
    "Online database": "wd:Q7094076",
    "Company register": "wd:Q1394657",
    "Business directory": "wd:Q897682",
    "Yellow Pages": "wd:Q934552",

    # Legal-sector
    "Law firm": "wd:Q613142",
    "Bar Association": "wd:Q1865205",
    "International Bar Association": "wd:Q763532",
    "Legal Bar": "wd:Q17015569",
    "barrister": "wd:Q808967",

}

SCHEMA_SQL = """CREATE TABLE IF NOT EXISTS websites
(
    item
    TEXT,
    item_label
    TEXT,
    website
    TEXT,
    type_label
    TEXT,
    PRIMARY
    KEY
                (
    item,
    website
                )
    );"""
INSERT_SQL = (
    "INSERT OR IGNORE INTO websites (item, item_label, website, type_label) "
    "VALUES (?, ?, ?, ?);"
)

QUERY_TEMPLATE = """SELECT ?item ?itemLabel ?website WHERE {{
  ?item wdt:P31 {type} .              # instance‑of filter
  # --- get **all** official‑website statements, not just the preferred one ---
  ?item p:P856/ps:P856 ?website .      # property path yields every rank (preferred + normal)
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"en\". }}
}}
ORDER BY ?item
LIMIT {limit}
OFFSET {offset}
"""


def build_query(type_uri: str, limit: int, offset: int) -> str:
    return QUERY_TEMPLATE.format(type=type_uri, limit=limit, offset=offset)


def fetch_batch(sparql: SPARQLWrapper, type_uri: str, limit: int, offset: int) -> List[Dict]:
    current_limit = limit
    for attempt in range(1, MAX_RETRIES + 1):
        sparql.setQuery(build_query(type_uri, current_limit, offset))
        try:
            raw = sparql.query().convert()
            return raw["results"]["bindings"]
        except (SPARQLExceptions.EndPointInternalError, json.JSONDecodeError) as e:
            wait = BACKOFF_BASE * (2 ** (attempt - 1))
            logging.warning(
                "Attempt %s/%s failed for offset %s (limit %s): %s – waiting %ss",
                attempt, MAX_RETRIES, offset, current_limit, e.__class__.__name__, wait,
            )
            time.sleep(wait)
            if attempt == 2 and current_limit > 5_000:
                current_limit //= 2
                logging.info("Reducing batch size to %s for retries", current_limit)
        except Exception as e:
            logging.warning("Unexpected error (%s). Retrying …", e)
            time.sleep(wait)
    logging.error("Skipping offset %s after %s unsuccessful attempts", offset, MAX_RETRIES)
    return []


def binding_to_tuple(b: Dict[str, Dict[str, str]], type_label: str) -> tuple[str, str, str, str]:
    """Convert a single SPARQL binding into the 4-column DB row.

    `type_label` is injected from the outer scope instead of coming from JSON.
    """
    return (
        b["item"]["value"],
        b.get("itemLabel", {}).get("value", ""),
        b.get("website", {}).get("value", ""),
        type_label,  # constant per-type value
    )


def fetch_for_type(conn: sqlite3.Connection, sparql: SPARQLWrapper, type_label: str, type_uri: str, max_records: int,
                   batch_size: int) -> int:
    logging.info(f"Fetching up to {max_records} rows for type: {type_label}")
    cur = conn.cursor()
    total = 0
    for offset in range(0, max_records, batch_size):
        logging.info(f" → Offset {offset} – {offset + batch_size - 1}")
        batch = fetch_batch(sparql, type_uri, batch_size, offset)
        if not batch:
            logging.info("No data returned – early stop.")
            break
        cur.executemany(
            INSERT_SQL,
            (binding_to_tuple(b, type_label) for b in batch)
        )
        conn.commit()
        total += len(batch)
        logging.info("   Inserted %s (running total: %s)", len(batch), total)
        if total >= max_records:
            break
    logging.info("✓ Finished %s (%s rows)", type_label, total)
    return total


def main(db_path: Path, max_records: int, batch_size: int):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
    sparql = SPARQLWrapper(ENDPOINT_URL, agent=USER_AGENT)
    sparql.setReturnFormat(JSON)

    conn = sqlite3.connect(db_path)
    conn.execute(SCHEMA_SQL)

    grand_total = 0
    for label, uri in TYPES.items():
        rows = fetch_for_type(conn, sparql, label, uri, max_records, batch_size)
        grand_total += rows

    conn.close()
    logging.info("✅ All types processed. Database saved to %s", db_path)
    logging.info("📊 Total rows inserted across all types: %s", grand_total)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch 200k per Wikidata type to SQLite")
    parser.add_argument("outfile", nargs="?", default="wikidata_websites4.db", help="SQLite destination path")
    parser.add_argument("--max", type=int, default=DEFAULT_MAX_RECORDS, help="Max rows per type (default 200 000)")
    parser.add_argument("--batch", type=int, default=DEFAULT_BATCH_SIZE, help="Batch size per query (default 20 000)")
    args = parser.parse_args()

    try:
        main(Path(args.outfile).expanduser(), args.max, args.batch)
    except KeyboardInterrupt:
        sys.exit("Interrupted – exiting cleanly.")
