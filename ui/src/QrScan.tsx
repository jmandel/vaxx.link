import React, { useState, useRef, useEffect } from 'react';
import { Button, Grid, Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { styled } from '@mui/system';
import { useNavigate, useLocation } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import frame from './assets/frame.png';
import { useQrDataContext } from './QrDataProvider';
import QrScanner from 'qr-scanner';
import { useErrorHandler } from 'react-error-boundary';

let qrScan: QrScanner;

const QrScan = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const handleErrorFallback = useErrorHandler();
  const { setQrCodes, resetQrCodes, qrCodes } = useQrDataContext();
  const [scannedCodes, setScannedCodes] = useState<(null | string)[]>([]);
  const [scannedData, setScannedData] = useState<string>('');
  const runningQrScanner = useRef<null | QrScanner>(null);
  const scannedCodesRef = useRef<(null | string)[]>([]);

  const theme = useTheme();
  const classes = {
    button: {
      '&:hover': {
        cursor: 'default',
      },
    },
    box: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      marginTop: '2em',
    },
    grid: {
      display: 'flex',
      flexDirection: 'column',
      flexWrap: 'nowrap',
      alignItems: 'center',
      justifyContent: 'center',
      width: 'auto',
      [theme.breakpoints.down('md')]: {
        maxHeight: '550px',
        maxWidth: '300px',
        margin: '1rem',
      },
      [theme.breakpoints.up('md')]: {
        maxHeight: '550px',
        maxWidth: '650px',
        margin: '2rem',
      },
    },
    gridContainerMultiple: {
      display: 'flex',
      flexDirection: 'row',
      flexGrow: 1,
      alignItems: 'right',
      justifyContent: 'right',
      paddingBottom: '1rem',
    },
    gridItem: {
      display: 'flex',
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
    },
  };

  const StyledImg = styled('img')({
    position: 'relative',
    [theme.breakpoints.down('md')]: {
      maxHeight: '550px',
      maxWidth: '300px',
    },
    [theme.breakpoints.up('md')]: {
      maxHeight: '550px',
      maxWidth: '650px',
    },
    objectFit: 'contain',
    zIndex: '2',
  });

  const confirmSHLCreation = () => {
    if (window.confirm('SMART Health Card successfully scanned. Create new SMART Health Link?') === true) {
      return true;
    } else {
      return false;
    }
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const getUserMedia = async () => {
    try {
      if (videoRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'environment' },
        });
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      if (err instanceof Error) {
        throw new Error(`Cannot access video: ${err.message}.`);
      }
    }
  };

  /**
   * Create QrScanner instance using video element and specify result/error conditions
   * @param {HTMLVideoElement | null} videoElement HTML video element
   */
  const createQrScanner = async (videoElement: HTMLVideoElement | null) => {
    if (!videoElement) {
      if (runningQrScanner.current) {
        qrScan.destroy();
      }
      return;
    }
    qrScan = new QrScanner(
      videoElement,
      (results) => {
        setScannedData(results.data);
      },
      {
        preferredCamera: 'environment',
        calculateScanRegion: (video) => ({
          // define scan region for QrScanner
          x: 0,
          y: 0,
          width: video.videoWidth,
          height: video.videoHeight,
        }),
      },
    );
    runningQrScanner.current = qrScan;

    qrScan.start();
  };

  // Get user media when the page first renders, and feed into createQrScanner()
  useEffect(() => {
    if (!runningQrScanner.current) {
      getUserMedia().then(async () => {
        await createQrScanner(videoRef.current);
      }, handleErrorFallback);
    }

    return () => {
      if (runningQrScanner.current) runningQrScanner.current.stop();
    };
  }, [handleErrorFallback, navigate]);

  useEffect(() => {
    const healthCardPattern =
      /^shc:\/(?<multipleChunks>(?<chunkIndex>[0-9]+)\/(?<chunkCount>[0-9]+)\/)?(?<payload>[0-9]+)$/;
    const parseHealthCardQr = (qrCode: string) => {
      if (healthCardPattern.test(qrCode)) {
        const match = qrCode.match(healthCardPattern);
        return match?.groups;
      }
      return null;
    };
    const handleScan = (data: string) => {
      const qrData = parseHealthCardQr(data);
      if (qrData && qrData.multipleChunks) {
        const chunkCount = +qrData.chunkCount;
        const currentChunkIndex = +qrData.chunkIndex;
        let tempScannedCodes = [...scannedCodesRef.current];
        if (tempScannedCodes.length !== chunkCount) {
          tempScannedCodes = new Array(chunkCount);
          tempScannedCodes.fill(null, 0, chunkCount);
        }

        if (tempScannedCodes[currentChunkIndex - 1] === null) {
          tempScannedCodes[currentChunkIndex - 1] = data;
        }
        if (tempScannedCodes.every((code) => code !== null)) {
          let scannedCodes: string[] = tempScannedCodes.flatMap((code) => (code ? [code] : []));
          if (confirmSHLCreation() === true) {
            resetQrCodes();
            setQrCodes(scannedCodes);
            navigate('/health-links/new?scanned=true');
          } else {
            navigate('/');
          }
        }
        setScannedCodes(tempScannedCodes);
        scannedCodesRef.current = tempScannedCodes;
      } else {
        if (confirmSHLCreation() === true) {
          resetQrCodes();
          setQrCodes([data]);
          navigate('/health-links/new?scanned=true');
        } else {
          navigate('/');
        }
      }
    };

    const handleError = () => {
      navigate('/error');
    };

    if (scannedData) {
      try {
        handleScan(scannedData);
      } catch (e) {
        handleError();
      }
    }

    return () => {
      setScannedData('');
    };
  }, [scannedData, navigate, location, setQrCodes, resetQrCodes, qrCodes]);

  return (
    <Box sx={classes.box}>
      <Grid container sx={classes.grid}>
        <Grid container item flexWrap="nowrap" width="100%" height="100%">
          {scannedCodes.length > 0 && (
            <Grid container item sx={classes.gridContainerMultiple}>
              {scannedCodes.map((code, i) => (
                <Button
                  sx={classes.button}
                  key={code || uuidv4()}
                  variant="contained"
                  color={code ? 'success' : 'error'}
                  disableRipple
                  style={{ marginRight: '0.5rem', zIndex: -1 }}
                >
                  {`${i + 1}/${scannedCodes.length}`}
                </Button>
              ))}
            </Grid>
          )}
        </Grid>
        <Grid item sx={classes.gridItem}>
          <video
            muted
            id="styled-video"
            ref={videoRef}
            style={{ objectFit: 'cover', position: 'absolute', width: '90%', height: '90%', zIndex: '1' }}
          />
          <StyledImg alt="Scan Frame" src={frame} />
        </Grid>
      </Grid>
    </Box>
  );
};

export default QrScan;
