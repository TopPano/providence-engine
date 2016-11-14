# Prerequisite
## Start etcd server (standalone)

```sh
$ export HostIP="Your host or IP"
$ export ETCD_CERT_PATH=/usr/share/ca-certificates/
$ sudo openssl req -newkey rsa:2048 -nodes -keyout ${ETCD_CERT_PATH}domain.crt -x509 -days 700 -out ${ETCD_CERT_PATH}domain.crt
$ docker run -d -v ${ETCD_CERT_PATH}:/etc/ssl/certs -p 4001:4001 -p 2380:2380 -p 2379:2379  --name etcd quay.io/coreos/etcd  /usr/local/bin/etcd -name etcd0  -advertise-client-urls http://$HostIP:2379,http://$HostIP:4001  -listen-client-urls http://0.0.0.0:2379,http://0.0.0.0:4001  -initial-advertise-peer-urls http://$HostIP:2380  -listen-peer-urls http://0.0.0.0:2380  -initial-cluster-token etcd-cluster-1  -initial-cluster etcd0=http://$HostIP:2380  -initial-cluster-state new
```

ref: https://coreos.com/etcd/docs/latest/docker_guide.html

## Start nats server (standalone)
```sh
$ docker run -d -p 4222:4222 --name nats-main nats
```

ref: https://hub.docker.com/_/nats/

## Start docker registry/hub (standalone)


```sh
# make dir for registry store data
$ mkdir /usr/share/docker-registry

# if dont have domain name, need use IP SAN
# ref: http://serverfault.com/questions/611120/failed-tls-handshake-does-not-contain-any-ip-sans

# gen openssl certificate
$ cd /usr/local/share/ca-certificates
# dont forget fill domain name in "Comman name" blank
$ openssl req -newkey rsa:2048 -nodes -keyout domain.key -x509 -days 700 -out domain.crt

# build & run registry container
docker run -d -p 5000:5000 --restart=always --name registry -v /usr/share/docker-registry:/var/lib/registry -v /usr/local/share/ca-certificates:/certs -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key  registry:2
```
ref: https://docs.docker.com/registry/deploying/

note: if the certificate is not from CA, then refer [this](https://success.docker.com/Datacenter/Solve/I_get_%22x509%3A_certificate_signed_by_unknown_authority%22_error_when_I_try_to_login_to_my_DTR_with_default_certificates) when a machine pull or push to the registry
