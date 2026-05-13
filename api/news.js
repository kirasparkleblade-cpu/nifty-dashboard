export default async function handler(req, res) {

    try {

        const RSS =
        "https://news.google.com/rss/search?q=(Nifty OR Sensex OR BankNifty OR NSE OR Indian stocks OR RBI OR earnings OR markets)&hl=en-IN&gl=IN&ceid=IN:en";

        const response =
        await fetch(RSS);

        const xml =
        await response.text();

        const items =
        [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]

        .map(match => {

            const item = match[1];

            const getTag = (tag) => {

                const regex =
                new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

                const result =
                item.match(regex);

                return result
                    ? result[1]
                        .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                        .trim()
                    : '';
            };

            return {

                title: getTag('title'),

                link: getTag('link'),

                pubDate: getTag('pubDate'),

                author: 'Google News'
            };
        });

        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );

        res.status(200).json({
            items
        });

    } catch (error) {

        res.status(500).json({
            error: 'Failed to fetch news'
        });
    }
}
