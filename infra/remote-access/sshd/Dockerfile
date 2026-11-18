# The relay's tunnel end — OB-840 · ADR-0035. OpenSSH's server, locked down (sshd_config): ONE user, ONE approved key
# (the store computer's), forwarding only, to 127.0.0.1:18095 inside this container only. No shell, no password.
FROM alpine:3.20
RUN apk add --no-cache openssh-server \
 && adduser -D -s /sbin/nologin sre-link \
 # A locked account ("!") is refused by sshd even for a key; "*" means "no password at all", which is what we want.
 && sed -i 's/^sre-link:!/sre-link:*/' /etc/shadow \
 && rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /etc/ssh/keys /etc/ssh/authorized /run/sshd
COPY sshd_config /etc/ssh/sshd_config
EXPOSE 2222
# -D: stay in front; -e: words to the container's log (docker compose logs tunnel).
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
