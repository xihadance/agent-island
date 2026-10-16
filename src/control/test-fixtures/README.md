The PEM files are a public, self-signed local-test certificate and its test key.
They cover only the reserved `api.invalid` and `gateway.invalid` names. The proxy
integration test trusts this certificate explicitly and verifies that an ordinary
production transport rejects it. These fixtures are never used by the app.
