# SecDash

Understand any public company in seconds. Enter a ticker or company name and
get a plain-English financial dashboard — revenue, profitability, cash flow,
peer comparison, and recent filings — pulled live from SEC EDGAR. No cached
snapshots, no synthetic data: every number links back to the primary filing
it came from.

## Stack

- **Backend**: FastAPI (Python), wraps SEC EDGAR's XBRL company-facts and
  submissions APIs (`backend/main.py`)
- **Frontend**: Static HTML/CSS/JS with D3 for charts (`frontend/`)
- **AI chat**: Optional Gemini-powered assistant that answers questions about
  the data currently on screen

## Setup

### 1. Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file in the project root (optional — only needed for the AI
chat feature):

```
GEMINI_API_KEY=your_key_here
```

Run the API server:

```bash
uvicorn backend.main:app --port 8000
```

### 2. Frontend

Serve the `frontend/` directory over HTTP (it must be served, not opened as
a `file://` path, since it calls the backend via `fetch`):

```bash
cd frontend
python3 -m http.server 8731
```

Open [http://localhost:8731](http://localhost:8731) in your browser.

> The backend's CORS config only allows `http://localhost:8731`. If you serve
> the frontend on a different port, update `allow_origins` in
> `backend/main.py`.

## Screenshots

![Home screen](data/home-screen.png)

![Company dashboard](data/user-interface.png)

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /companies/{ticker}/financials` | Annual revenue, income, cash flow, and balance-sheet figures |
| `GET /companies/{ticker}/filings` | Recent SEC filings (10-K, 10-Q, 8-K, etc.) |
| `GET /companies/{ticker}/profile` | Company identity: industry, exchange, incorporation, fiscal year end |
| `GET /companies/{ticker}/peers` | Same-industry companies of comparable size, by revenue |
| `GET /companies/search?q=` | Search the full SEC ticker universe by name or symbol |
| `POST /chat` | AI chat about the data currently shown on the dashboard (requires `GEMINI_API_KEY`) |

## Notes

- Rate-limited to stay under SEC's 10 requests/second cap.
- The ticker list is cached for 24 hours; company facts and filings are
  fetched fresh on every request.
- If the backend or a given data field is unavailable, the dashboard shows
  an explicit "no data" state — it never falls back to hardcoded or mock
  figures.
