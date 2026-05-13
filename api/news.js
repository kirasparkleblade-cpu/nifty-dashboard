export default async function handler(req, res) {

    try {

        const feeds = [

            'https://www.moneycontrol.com/rss/business.xml',

            'https://www.moneycontrol.com/rss/markets.xml',

            'https://www.moneycontrol.com/rss/economy.xml'
        ];

        let allNews = [];

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
                : 'No title';

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
                    pubDate
                };
            });

            allNews.push(...parsed);
        }

        allNews = allNews

        .filter(item =>
            item.title &&
            item.title !== 'No title')

        .sort((a,b)=>
            new Date(b.pubDate) -
            new Date(a.pubDate))

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
