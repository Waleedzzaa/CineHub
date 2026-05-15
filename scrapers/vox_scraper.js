const { Builder, By, until } = require('selenium-webdriver');

async function scrapeVox() {
    let driver = await new Builder().forBrowser('chrome').build();

    try {
        let targetUrl = 'https://ksa.voxcinemas.com/showtimes/red-sea-mall-jeddah';
        await driver.get(targetUrl);

        let movieSelector = By.css('article.movie-compare');
        let waitCondition = until.elementLocated(movieSelector);
        await driver.wait(waitCondition, 10000);

        let movies = await driver.findElements(movieSelector);
        let results = [];

        for (let movie of movies) {
            
            let titleElement = await movie.findElement(By.css('aside h2'));
            let titleText = await titleElement.getText();
            
            let showtimesArray = [];

            let experienceGroupSelector = By.css('.showtimes > li');
            let experienceGroups = await movie.findElements(experienceGroupSelector);

            for (let group of experienceGroups) {
                
                let experienceElement = await group.findElement(By.css('strong'));
                let experienceText = await experienceElement.getText();

                let showtimeSelector = By.css('.action.showtime');
                let showtimeElements = await group.findElements(showtimeSelector);
                
                for (let showtimeElement of showtimeElements) {
                    
                    let rawTime = await showtimeElement.getText();
                    let cleanTime = rawTime.trim();
                    
                    let linkUrl = await showtimeElement.getAttribute('href');
                    let dataId = await showtimeElement.getAttribute('data-id');

                    let showtimeData = {};
                    showtimeData.time = cleanTime;
                    showtimeData.experience = experienceText;
                    showtimeData.link = linkUrl;
                    showtimeData.id = dataId;

                    showtimesArray.push(showtimeData);
                }
            }

            let movieData = {};
            movieData.title = titleText;
            movieData.showtimes = showtimesArray;

            results.push(movieData);
        }

        let jsonOutput = JSON.stringify(results, null, 2);
        console.log(jsonOutput);

    } catch (error) {
        console.log('Scraping error:');
        console.log(error);
    } finally {
        await driver.quit();
    }
}

scrapeVox();
