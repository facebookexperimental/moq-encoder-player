#!/usr/bin/env bash

# Copyright (c) Meta Platforms, Inc. and affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

mkdir -p certs      

openssl ecparam -name secp384r1 -genkey -out ./certs/certificate.key

openssl req -new -x509 -days 10 -subj '/CN=Test Certificate' -addext "subjectAltName = DNS:localhost" -key ./certs/certificate.key -sha384 -out ./certs/certificate.pem

# Compute fingerprint
openssl x509 -in ./certs/certificate.pem -outform der | openssl dgst -sha256 -binary > ./certs/certificate_fingerprint.hex