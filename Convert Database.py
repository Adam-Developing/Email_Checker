from __future__ import annotations
import argparse, logging, sqlite3
from pathlib import Path
import tldextract                                    # pip install tldextract

DEFAULT_BATCH = 10_000

SCHEMA_ALTERS = [
    "ALTER TABLE websites ADD COLUMN domain TEXT",
    "ALTER TABLE websites ADD COLUMN subdomain TEXT",
]

# composite-key update prevents clobbering                           ─┐
UPDATE_SQL = """UPDATE websites SET domain = ?, subdomain = ?
                WHERE item = ? AND website = ?;"""                   #│

# stop fetching rows that have no URL                               ─┘
SELECT_SQL = """SELECT item, website
                FROM   websites
                WHERE  domain IS NULL
                  AND  website IS NOT NULL
                  AND  website <> ''
                LIMIT  ?;"""

def ensure_columns(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(websites);")
    current = {row[1] for row in cur.fetchall()}
    for stmt in SCHEMA_ALTERS:
        col = stmt.split()[5]            # “domain” / “subdomain” not “COLUMN”
        if col not in current:
            logging.info("Adding column %s", col)
            cur.execute(stmt)
            conn.commit()
            current.add(col)             # keep PRAGMA cache in sync :contentReference[oaicite:0]{index=0}

def extract_parts(url: str) -> tuple[str | None, str | None]:
    tld = tldextract.extract(url)
    if not tld.suffix:                   # unrecognised host → mark as done
        return '', None                  # empty string is our sentinel
    reg = f"{tld.domain}.{tld.suffix}"
    sub = f"{tld.subdomain}.{reg}" if tld.subdomain and tld.subdomain.lower() != "www" else None
    return reg, sub

def backfill(conn: sqlite3.Connection, batch: int) -> None:
    sel, upd = conn.cursor(), conn.cursor()
    total = 0
    while True:
        sel.execute(SELECT_SQL, (batch,))
        rows = sel.fetchall()
        if not rows:                     # nothing left to do → exit
            break
        data = []
        for item, url in rows:
            dom, sub = extract_parts(url)
            data.append((dom, sub, item, url))
        upd.executemany(UPDATE_SQL, data)
        conn.commit()
        total += len(data)
        logging.info("Updated %d rows (running total %d)", len(data), total)
    logging.info("✓ Finished – %d rows enriched", total)

def main(db: Path, batch: int):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
    with sqlite3.connect(db) as conn:
        ensure_columns(conn)
        backfill(conn, batch)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Enrich websites table with domain info")
    ap.add_argument("db", nargs="?", default="wikidata_websites4.db")
    ap.add_argument("--batch", type=int, default=DEFAULT_BATCH)
    args = ap.parse_args()
    main(Path(args.db).expanduser(), args.batch)
