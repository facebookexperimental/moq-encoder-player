#!/usr/bin/env bash

# Copyright (c) Meta Platforms, Inc. and affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

mkdir -p certs      

KEY_FILE="./certs/certificate.key"
openssl ecparam -name secp384r1 -genkey -out $KEY_FILE
echo "Created $KEY_FILE"

CERT_FILE="./certs/certificate.pem"
openssl req -new -x509 -days 10 -subj '/CN=Test Certificate' -addext "subjectAltName = DNS:localhost" -key $KEY_FILE -sha384 -out $CERT_FILE
echo "Created $CERT_FILE"

# Compute fingerprint
FINGUERPRINT_FILE="./certs/certificate_fingerprint.hex"
openssl x509 -in $CERT_FILE -outform der | openssl dgst -sha256 -binary > $FINGUERPRINT_FILE
echo "Created $FINGUERPRINT_FILE"