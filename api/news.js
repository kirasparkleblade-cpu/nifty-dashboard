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

                return {

                    title:
                    content.match(
                    /<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                    || 'No title',

                    link:
                    content.match(
                    /<link>(.*?)<\/link>/)?.[1]
                    || '#',

                    pubDate:
                    content.match(
                    /<pubDate>(.*?)<\/pubDate>/)?.[1]
                    || ''
                };
            });

            allNews.push(...parsed);
        }

        allNews = allNews
        .sort((a,b)=>
            new Date(b.pubDate) -
            new Date(a.pubDate))
        .slice(0,20);

        res.status(200).json(allNews);

    }

    catch(error){

        res.status(500).json({
            error:'Unable to fetch news'
        });
    }
}
