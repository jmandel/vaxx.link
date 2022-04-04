npm ci

curl https://docs.google.com/spreadsheets/d/1Qggy9hFuKkUz1cwmx6xk30wJrMbdVuckx7csfeCWRiA/gviz/tq?tqx=out:json  | \
    tail -n 1 | \
    sed   -r "s/google.visualization.Query.setResponse\((.*)\);/\1/"  | \
    jq '.' \
> gsheet.json

npm run --silent  generate-examples  > ../examples-oliver-brown.json
