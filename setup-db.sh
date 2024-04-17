#! /usr/bin/env bash

flags="--local"
if [ "$1" == "--remote" ]; then
    flags="--remote"
fi

# For each file in ./schemas
for file in ./schemas/*.sql; do
    echo "Running $file"
    npx wrangler d1 execute sisyphus $flags --file=$file
done

admin_token=$(uuidgen)
npx wrangler kv:key put $admin_token "00000000-0000-0000-0000-000000000000|<ROOT>" --binding sisyphus_user_tokens $flags

echo "==Admin token=="
echo "$admin_token"