import sqlite3
import urllib.request
import ssl
import tldextract

# 1. Config
DB_FILE = "wikidata_websites4.db"
WORDLIST_URL = "https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt"

def populate_allow_list():
    print(f"Connecting to {DB_FILE}...")
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # 2. Ensure table exists
    cursor.execute("""
                   CREATE TABLE IF NOT EXISTS allow_list (
                                                             word TEXT PRIMARY KEY
                   )
                   """)

    # 3. Download the Dictionary
    print("Downloading common English words...")
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(WORDLIST_URL, context=context) as response:
        content = response.read().decode('utf-8')

    words = content.splitlines()
    print(f"Fetched {len(words)} words.")

    # 4. Filter and Insert
    # We filter out very short words (<= 2 chars) to rely on exact brand matching for those.
    count = 0
    for word in words:
        word = word.strip().lower()
        if len(word) > 2:
            try:
                cursor.execute("INSERT OR IGNORE INTO allow_list (word) VALUES (?)", (word,))
                count += 1
            except sqlite3.Error as e:
                print(f"Error inserting {word}: {e}")

    conn.commit()
    conn.close()
    print(f"Success! Added {count} safe words to the 'allow_list'.")


def sync_protected_brands():
    print(f"Connecting to {DB_FILE}...")
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # 1. Ensure the table exists
    cursor.execute("""
                   CREATE TABLE IF NOT EXISTS protected_brands (
                                                                   sld TEXT PRIMARY KEY,
                                                                   sensitivity INTEGER DEFAULT 2
                   )
                   """)

    # 2. Fetch all raw domains
    print("Fetching existing domains...")
    cursor.execute("SELECT domain FROM websites")
    rows = cursor.fetchall() # Fetches all rows as a list of tuples

    # Use a set to handle duplicates in memory before hitting the DB
    unique_slds = set()

    print(f"Processing {len(rows)} domains...")

    # 3. Extract SLD Smartly
    for row in rows:
        raw_domain = row[0]
        if not raw_domain:
            continue

        # tldextract handles the "publicsuffix" logic automatically.
        # e.g., 'bbc.co.uk' -> extracted.domain == 'bbc'
        # e.g., 'google.com' -> extracted.domain == 'google'
        extracted = tldextract.extract(raw_domain)
        sld = extracted.domain

        # 4. Filter: Skip tiny common acronyms to reduce noise (Logic from Go code)
        if sld and len(sld) > 3:
            unique_slds.add((sld,))

    # 5. Bulk Insert into Optimised Index
    print(f"Inserting {len(unique_slds)} unique brands into protected_brands...")

    try:
        cursor.executemany("INSERT OR IGNORE INTO protected_brands (sld) VALUES (?)", list(unique_slds))
        conn.commit()
        print("Sync complete.")
    except sqlite3.Error as e:
        print(f"Database error: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    populate_allow_list()
    sync_protected_brands()
