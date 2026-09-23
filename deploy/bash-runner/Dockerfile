# 服务器无法直连 Docker Hub，部署时用 --build-arg 指定镜像源前缀。
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

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
