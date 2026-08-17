# Paginate list endpoint

The public suite covers the default page and the first explicit page. It intentionally leaves the
last-page boundary and rejected query values to the hidden suite. The endpoint is split across the
list and server modules so the API change exercises more than a single slice expression.
