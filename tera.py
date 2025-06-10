import requests
from urllib.parse import urljoin
from bs4 import BeautifulSoup
base_url = "https://developer.mozilla.org/ja/docs/Web/JavaScript/Guide"
req = requests.get(base_url)
req.raise_for_status()

soup = BeautifulSoup(req.content,'html.parser')
main_content = soup.find('main')

if main_content:
    links = main_content.find_all('a', href=True) 
    print(f"'{base_url}' から見つかったリンク:")
    print("-" * 30)

    for link in links:
            href = link['href']
            absolute_url = urljoin(base_url, href)
            print(absolute_url)