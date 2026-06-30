"""Throwaway: render the report to /tmp/report_sample.pdf from the captured
payload fixture, in-process (no server). Run with the main checkout's venv +
DYLD_FALLBACK_LIBRARY_PATH so WeasyPrint finds its native libs."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

from flask import Flask
import report

app = Flask(__name__,
            template_folder=os.path.join(REPO, 'templates'),
            static_folder=os.path.join(REPO, 'static'))

with app.app_context():
    payload = json.load(open(os.path.join(HERE, 'fixtures', 'report_payload.json')))
    css = 'file://' + os.path.join(REPO, 'static', 'report.css')
    pdf = report.generate_pdf(payload, css_url=css, request_root='file://' + REPO + '/')
    out = '/tmp/report_sample.pdf'
    open(out, 'wb').write(pdf)
    print('wrote', out, len(pdf), 'bytes')
