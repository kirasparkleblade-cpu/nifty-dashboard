export default async function handler(req, res) {

    const RSS =
    "https://news.google.com/rss/search?q=(Nifty OR Sensex OR BankNifty OR NSE OR Indian stocks OR RBI OR earnings OR markets)&hl=en-IN&gl=IN&ceid=IN:en";

    const API =
    `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(RSS)}`;

    try {

        const response = await fetch(API);

        const data = await response.json();

        res.setHeader('Access-Control-Allow-Origin', '*');

        res.status(200).json(data);

    } catch (error) {

        res.status(500).json({
            error: "Failed to fetch news"
        });
    }
}
