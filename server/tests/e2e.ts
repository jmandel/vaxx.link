async function test() {
  console.log('Testing server');
  const clientKey = await jose.generateKeyPair('ES256');

  const shlResponse = await fetch(`${env.PUBLIC_URL}/api/shl`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      encrypted: true,
      pin: '1234',
    }),
  });

  const shl = (await shlResponse.json()) as HealthLink;
  console.log('SHL', shl);

 const shlFileResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl.token}/file`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${shl.managementToken}`
    },
    body: JSON.stringify({arbitrary: true, answer: 42}),
  });

  const shlFile = await shlFileResponse.json();
  console.log("SHL file response", shlFile)
  

  const discoveryResponse = await fetch(`${shl.url}/.well-known/smart-configuration`);
  const discovery: { token_endpoint: string; registration_endpoint: string } = await discoveryResponse.json();

  const registeredResponse = await fetch(`${discovery.registration_endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${shl.token}`,
    },
    body: JSON.stringify({
      token_endpoint_auth_method: 'private_key_jwt',
      grant_types: ['client_credentials'],
      jwks: {
        keys: [await jose.exportJWK(clientKey.publicKey)],
      },
      client_name: "Dr. B's Quick Response Squared", // optional
      contacts: ['drjones@clinic.com'], // optional
    }),
  });

  const registered = (await registeredResponse.json()) as OAuthRegisterResponse;
  console.log('Registered', JSON.stringify(registered, null, 2));

  const clientAssertion = await new jose.SignJWT({
    sub_jwk: await jose.exportJWK(clientKey.publicKey),
  })
    .setIssuer(registered.client_id)
    .setSubject(registered.client_id)
    .setAudience(`${env.PUBLIC_URL}/oauth/token`)
    .setExpirationTime('3 minutes')
    .setProtectedHeader({ alg: 'ES256' })
    .setJti(randomStringWithEntropy(32))
    .sign(clientKey.privateKey);

  console.log('Generated assertion', clientAssertion);
  const tokenResponse = await fetch(`${discovery.token_endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Shlink-Pin': '1234',
    },
    body: queryString.stringify({
      scope: '__shlinks',
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
    }),
  });

  const tokenResponseJson = await tokenResponse.json() as AccessTokenResponse;
  console.log("Access Token Response", tokenResponseJson)

  const fileResponse = await fetch(tokenResponseJson.access[0].locations[0], {
    headers: {
      'Authorization': `Bearer ${tokenResponseJson.access_token}`
    }
  })

  const file = await fileResponse.text()
  console.log("got filef", fileResponse.status, file)
}
await test();
