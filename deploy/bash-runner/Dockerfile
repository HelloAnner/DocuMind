FROM python:3.12-slim

RUN pip install --no-cache-dir \
    python-docx==1.2.0 \
    openpyxl==3.1.5 \
    python-pptx==1.0.2

COPY apps/api-bun/src/skills/scripts/ /opt/cnpc-skills/
COPY deploy/bash-runner/smoke.py /opt/cnpc-skills/smoke.py
RUN chmod 0555 /opt/cnpc-skills/*.py

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/bin/bash", "--noprofile", "--norc", "-c"]
