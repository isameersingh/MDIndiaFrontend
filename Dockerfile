
FROM nginx:alpine

# Remove the default Nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy frontend files
COPY index.html /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/
COPY citation-viewer.js /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/
COPY logo/ /usr/share/nginx/html/logo/

# Copy environment configuration if required
COPY env.js /usr/share/nginx/html/

# Expose HTTP port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
