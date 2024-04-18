#! /usr/bin/env bash

d1_env="--local"
kv_env="--local"
if [ "$1" == "--remote" ]; then
    d1_env="--remote"
    kv_env=""
fi

# For each file in ./schemas
for file in ./schemas/*.sql; do
    echo "Running $file"
    npx wrangler d1 execute kelpie $d1_env --file=$file
done

admin_token=$(uuidgen)
npx wrangler kv:key put $admin_token "00000000-0000-0000-0000-000000000000|<ROOT>|<ROOT>" --binding user_tokens $kv_env

echo "==Admin token=="
echo "$admin_token"