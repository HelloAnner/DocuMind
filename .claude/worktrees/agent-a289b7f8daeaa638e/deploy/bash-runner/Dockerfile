# 服务器无法直连 Docker Hub / pypi.org，默认走可达镜像源；可用 --build-arg BASE_IMAGE 覆盖。
ARG BASE_IMAGE=m.daocloud.io/docker.io/library/python:3.12-slim
FROM ${BASE_IMAGE}

RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple \
    python-docx==1.2.0 \
    openpyxl==3.1.5 \
    python-pptx==1.0.2

COPY apps/api-bun/src/skills/scripts/ /opt/cnpc-skills/
COPY deploy/bash-runner/smoke.py /opt/cnpc-skills/smoke.py
RUN chmod 0555 /opt/cnpc-skills/*.py

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/bin/bash", "--noprofile", "--norc", "-c"]
