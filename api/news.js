export default async function handler(req, res) {

    try {

        const feeds = [

            'https://www.moneycontrol.com/rss/business.xml',

            'https://www.moneycontrol.com/rss/markets.xml',

            'https://www.moneycontrol.com/rss/economy.xml'
        ];

        let allNews = [];

        const now = new Date();

        for (const feed of feeds) {

            const response = await fetch(feed);

            const text = await response.text();

            const items =
            [...text.matchAll(
            /<item>([\s\S]*?)<\/item>/g)];

            const parsed = items.map(item => {

                const content = item[1];

                const titleMatch =
                content.match(
                /<title>([\s\S]*?)<\/title>/);

                const linkMatch =
                content.match(
                /<link>([\s\S]*?)<\/link>/);

                const dateMatch =
                content.match(
                /<pubDate>([\s\S]*?)<\/pubDate>/);

                let title =
                titleMatch
                ? titleMatch[1]
                : '';

                title = title
                .replace(/<!\[CDATA\[/g,'')
                .replace(/\]\]>/g,'')
                .trim();

                const link =
                linkMatch
                ? linkMatch[1].trim()
                : '#';

                const pubDate =
                dateMatch
                ? dateMatch[1].trim()
                : '';

                return {

                    title,
                    link,
                    pubDate,
                    timestamp:
                    new Date(pubDate).getTime()
                };
            });

            allNews.push(...parsed);
        }

        allNews = allNews

        .filter(item => {

            if(!item.title) return false;

            const diffDays =
            (now - new Date(item.pubDate))
            / (1000 * 60 * 60 * 24);

            return diffDays <= 3;
        })

        .sort((a,b)=>
            b.timestamp - a.timestamp)

        .slice(0,20);

        res.status(200).json(allNews);

    }

    catch(error){

        console.error(error);

        res.status(500).json({
            error:'Unable to fetch news'
        });
    }
}
