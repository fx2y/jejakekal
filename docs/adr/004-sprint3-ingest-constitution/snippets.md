# Snippets

```sh
# canonical start
curl -sS -X POST :4010/runs -H 'content-type: application/json' \
  -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":50}'
```

```sh
# hostile path probe
curl --path-as-is -i :4010/runs/%2E%2E
```

```sql
-- fts sanity
select doc_id,ver,block_id,ts_rank(tsv,q) r
from block,to_tsquery('english','alpha') q
where tsv @@ q
order by r desc
limit 5;
```

```txt
effect_key = workflow|step|doc|ver|sha
```
