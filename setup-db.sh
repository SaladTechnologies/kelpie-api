#! /usr/bin/env bash

d1_env="--local"
kv_env="--local"
admin_token="178f0334-69b1-4d03-a96b-b9cfc7ee4b22"
if [ "$1" == "--remote" ]; then
    d1_env="--remote"
    kv_env=""
    admin_token=$(uuidgen)
fi

# For each file in ./schemas
for file in ./schemas/*.sql; do
    echo "Running $file"
    npx wrangler d1 execute kelpie $d1_env --file=$file
done

npx wrangler kv key put $admin_token "00000000-0000-0000-0000-000000000000|<ROOT>|<ROOT>" --binding user_tokens $kv_env

echo "==Admin token=="
echo "$admin_token"
