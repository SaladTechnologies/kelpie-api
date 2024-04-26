#! /usr/bin/env bash

./setup-db.sh --local

container_group=$(cat ./fixtures/container-group.json)
container_group_id=$(echo $container_group | jq -r '.id')

npx wrangler kv:key put $container_group_id "${container_group}" --binding salad_cache --local