FROM python:3.12-slim

COPY requirements.txt ./requirements.txt

RUN pip3 install --no-cache-dir -r requirements.txt

RUN mkdir -p /app && \
    mkdir -p /app/src && \
    mkdir -p /app/data && \
    mkdir -p /app/model

RUN chgrp -R nogroup /app && \
    chmod -R 770 /app

COPY src/ /app/src/

ENV PYTHONPATH=/app/src \
    MODEL_DIR=/mnt/models/ \
    DATA_DIR=/app/data/ \
    TRAIN_FILE=train.csv \
    VALIDATION_FILE=validation.csv \
    TEST_FILE=test.csv \
    MODEL_OUT_DIR=/app/model/ \
    MODEL_VERSION=v3-chronological-holdout \
    CONTAMINATION=0.05

EXPOSE 9001

CMD ["python3", "/app/src/serve.py"]
