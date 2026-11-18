# The relay's tunnel end — OB-840 · ADR-0035. OpenSSH's server, locked down (sshd_config): ONE user, ONE approved key
# (the store computer's), forwarding only, to 127.0.0.1:18095 inside this container only. No shell, no password.
FROM alpine:3.20
RUN apk add --no-cache openssh-server \
 && adduser -D -u 10022 -s /sbin/nologin sre-link \
 # A locked account ("!") is refused by sshd even for a key; "*" means "no password at all", which is what we want.
 && sed -i 's/^sre-link:!/sre-link:*/' /etc/shadow \
 && rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /etc/ssh/keys /etc/ssh/authorized
COPY sshd_config /etc/ssh/sshd_config
EXPOSE 2222
# QG-03 (DS002): the server runs as the one user it lets in, never as root. An unprivileged sshd can only sign in its own
# user — exactly the one it is for — on a port above 1024; the host key is that user's (setup-relay.sh chowns it to 10022).
USER sre-link
# -D: stay in front; -e: words to the container's log (docker compose logs tunnel).
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
