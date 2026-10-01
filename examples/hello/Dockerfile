# A custom image: a tiny web server built from this folder on each machine.
FROM python:3.12-alpine
WORKDIR /srv
COPY index.html .
EXPOSE 9000
CMD ["python", "-m", "http.server", "9000"]
