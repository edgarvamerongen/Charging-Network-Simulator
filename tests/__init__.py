# Redirect the short-link store (shares.py) to a throwaway DB for the whole
# test run, so importing app.py during tests never writes the real
# data/shares.db. Individual test modules may override CNS_SHARES_DB.
import os as _os
import tempfile as _tempfile

_os.environ.setdefault(
    'CNS_SHARES_DB',
    _os.path.join(_tempfile.gettempdir(), 'cns_test_shares.db'),
)
